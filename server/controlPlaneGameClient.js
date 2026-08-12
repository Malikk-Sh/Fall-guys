'use strict';

const crypto = require('crypto');
const http = require('http');

const DEFAULT_GAME_HOST = '127.0.0.1';
const DEFAULT_GAME_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 3500;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const GAME_ADMIN_PATHS = Object.freeze([
  '/api/admin/dashboard',
  '/api/admin/analytics',
  '/api/admin/players/search',
  '/api/admin/players/detail',
  '/api/admin/incidents/player',
  '/api/admin/players/logout',
  '/api/admin/players/rename',
  '/api/admin/moderation/queue',
  '/api/admin/moderation/case',
  '/api/admin/moderation/transition',
  '/api/admin/sanctions/apply',
  '/api/admin/sanctions/revoke'
]);
const GAME_ADMIN_PATH_SET = new Set(GAME_ADMIN_PATHS);

function safePort(value, fallback = DEFAULT_GAME_PORT) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function safeJsonBody(value) {
  const body = Buffer.from(JSON.stringify(value == null ? {} : value), 'utf8');
  if (body.byteLength > MAX_REQUEST_BYTES) return null;
  return body;
}

function parseJsonResponse(buffer, statusCode) {
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid-json-shape');
    return { statusCode, payload: parsed };
  } catch {
    return {
      statusCode: statusCode >= 400 ? statusCode : 502,
      payload: { ok: false, error: 'game-control-invalid-response' }
    };
  }
}

class ControlPlaneGameClient {
  constructor({
    host = DEFAULT_GAME_HOST,
    port = process.env.PORT || DEFAULT_GAME_PORT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    request = http.request
  } = {}) {
    if (String(host) !== DEFAULT_GAME_HOST) {
      throw new Error('ControlPlaneGameClient only supports the loopback gameplay host');
    }
    this.host = DEFAULT_GAME_HOST;
    this.port = safePort(port);
    this.timeoutMs = Math.max(250, Math.min(10_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    this.request = request;
  }

  allowed(path) {
    return GAME_ADMIN_PATH_SET.has(String(path || ''));
  }

  adminRequest(path, { body = {}, cookie = '', csrf = '' } = {}) {
    const route = String(path || '');
    if (!this.allowed(route)) {
      return Promise.resolve({
        statusCode: 404,
        payload: { ok: false, error: 'admin-route-not-found' },
        contactedUpstream: false
      });
    }
    const encoded = safeJsonBody(body);
    if (!encoded) {
      return Promise.resolve({
        statusCode: 413,
        payload: { ok: false, error: 'admin-request-too-large' },
        contactedUpstream: false
      });
    }
    return this.#request({
      path: route,
      method: 'POST',
      body: encoded,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(encoded.byteLength),
        ...(cookie ? { Cookie: String(cookie).slice(0, 4096) } : {}),
        ...(csrf ? { 'X-Wobble-Admin-CSRF': String(csrf).slice(0, 256) } : {}),
        'X-Wobble-Control-Request': crypto.randomUUID()
      }
    });
  }

  health() {
    return this.#request({
      path: '/health',
      method: 'GET',
      body: null,
      headers: { 'X-Wobble-Control-Request': crypto.randomUUID() },
      maxResponseBytes: 256 * 1024
    }).then(result => {
      if (result.statusCode < 200 || result.statusCode >= 300 || result.payload?.ok !== true) {
        return null;
      }
      return result.payload;
    });
  }

  #request({ path, method, body, headers, maxResponseBytes = MAX_RESPONSE_BYTES }) {
    return new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const request = this.request(
        {
          host: this.host,
          port: this.port,
          path,
          method,
          headers,
          timeout: this.timeoutMs
        },
        response => {
          const chunks = [];
          let bytes = 0;
          response.on('data', chunk => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > maxResponseBytes) {
              response.destroy();
              finish({
                statusCode: 502,
                payload: { ok: false, error: 'game-control-response-too-large' },
                contactedUpstream: true
              });
              return;
            }
            chunks.push(chunk);
          });
          response.once('end', () => {
            if (settled) return;
            const parsed = parseJsonResponse(Buffer.concat(chunks), Number(response.statusCode || 502));
            finish({ ...parsed, contactedUpstream: true });
          });
          response.once('error', () => {
            finish({
              statusCode: 503,
              payload: { ok: false, error: 'game-control-unavailable' },
              contactedUpstream: true
            });
          });
        }
      );
      request.once('timeout', () => {
        request.destroy();
        finish({
          statusCode: 503,
          payload: { ok: false, error: 'game-control-unavailable' },
          contactedUpstream: true
        });
      });
      request.once('error', () => {
        finish({
          statusCode: 503,
          payload: { ok: false, error: 'game-control-unavailable' },
          contactedUpstream: true
        });
      });
      if (body) request.end(body);
      else request.end();
    });
  }
}

module.exports = {
  ControlPlaneGameClient,
  GAME_ADMIN_PATHS,
  DEFAULT_GAME_HOST,
  DEFAULT_GAME_PORT,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  safePort
};
