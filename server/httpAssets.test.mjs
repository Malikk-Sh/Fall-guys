import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const {
  NO_CACHE,
  contentSecurityPolicy,
  inlineScriptHashes,
  installSpaFallback,
  installStaticShell
} = require('./httpAssets');

const IMPORT_MAP = '{"imports":{"three":"/vendor/three.module.js"}}';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-http-assets-'));
  const clientPath = path.join(root, 'client');
  const sharedPath = path.join(root, 'shared');
  const vendorPath = path.join(root, 'vendor');
  const addonsPath = path.join(root, 'addons');
  for (const directory of [clientPath, sharedPath, vendorPath, addonsPath]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(
    path.join(clientPath, 'index.html'),
    `<!doctype html><script type="importmap">${IMPORT_MAP}</script><script src="/main.js"></script><body>ok</body>`
  );
  fs.writeFileSync(path.join(clientPath, 'main.js'), 'export const ok = true;\n');
  fs.writeFileSync(path.join(sharedPath, 'protocol.js'), 'export const VERSION = 1;\n');
  fs.writeFileSync(path.join(vendorPath, 'three.module.js'), 'export const three = true;\n');
  fs.writeFileSync(path.join(addonsPath, 'postprocessing.js'), 'export const fx = true;\n');
  return { root, clientPath, sharedPath, vendorPath, addonsPath };
}

async function serve(t) {
  const paths = fixture();
  const app = express();
  app.disable('x-powered-by');
  installStaticShell(app, paths);
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  installSpaFallback(app, { clientPath: paths.clientPath });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(paths.root, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, paths };
}

function get(base, target) {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}${target}`, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      })
      .on('error', reject);
  });
}

test('политика разрешает ровно встроенные скрипты страницы и ничего сверх того', async t => {
  const { base, paths } = await serve(t);
  const response = await get(base, '/');
  const policy = response.headers['content-security-policy'];

  const importMapHash = `'sha256-${crypto.createHash('sha256').update(IMPORT_MAP, 'utf8').digest('base64')}'`;
  assert.ok(policy.includes(`script-src 'self' ${importMapHash}`), 'import map разрешён по хешу');
  const scriptSrc = policy.split('; ').find(directive => directive.startsWith('script-src'));
  assert.equal(scriptSrc.includes('unsafe-inline'), false, 'встроенный скрипт разрешается только по хешу');
  assert.ok(policy.includes("default-src 'self'"));
  assert.ok(policy.includes("frame-ancestors 'none'"));
  assert.ok(policy.includes("form-action 'none'"));
  assert.ok(policy.includes("connect-src 'self' ws: wss:"), 'игровой WebSocket остаётся разрешён');

  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.ok(response.headers['permissions-policy'].includes('geolocation=()'));

  // Пустой <script src> не должен превращаться в хеш пустой строки: разрешать нечего.
  assert.equal(inlineScriptHashes(paths.clientPath).length, 1);
});

test('скрипт со сторонним хешем политикой не разрешается', () => {
  const policy = contentSecurityPolicy(["'sha256-abc'"]);
  assert.ok(policy.includes("script-src 'self' 'sha256-abc'"));
  assert.equal(policy.includes("'sha256-other'"), false);
});

test('клиент и общие правила не кэшируются, а vendor кэшируется надолго', async t => {
  const { base } = await serve(t);

  assert.equal((await get(base, '/main.js')).headers['cache-control'], NO_CACHE);
  assert.equal((await get(base, '/shared/protocol.js')).headers['cache-control'], NO_CACHE);

  const vendor = await get(base, '/vendor/three.module.js');
  assert.ok(vendor.headers['cache-control'].includes('immutable'));
  assert.ok(vendor.headers['cache-control'].includes('max-age=86400'));

  const addon = await get(base, '/vendor/addons/postprocessing.js');
  assert.equal(addon.status, 200);
  assert.ok(addon.headers['cache-control'].includes('immutable'));
});

test('index.html отдаётся навигационным запросам, но не запросам к ассетам', async t => {
  const { base } = await serve(t);

  const navigation = await get(base, '/lobby/some-room');
  assert.equal(navigation.status, 200);
  assert.ok(navigation.body.includes('<body>ok</body>'));
  assert.equal(navigation.headers['cache-control'], NO_CACHE);

  const missingAsset = await get(base, '/does-not-exist.js');
  assert.equal(missingAsset.status, 404, 'браузер должен получить 404, а не HTML вместо модуля');
});

test('маршруты, объявленные до отката, продолжают отвечать сами', async t => {
  const { base } = await serve(t);
  const api = await get(base, '/api/ping');
  assert.equal(api.status, 200);
  assert.equal(JSON.parse(api.body).ok, true);
});

test('нечитаемый index.html оставляет политику строгой, а не открытой', () => {
  assert.deepEqual(inlineScriptHashes(path.join(os.tmpdir(), 'wobble-missing-client')), []);
  assert.equal(contentSecurityPolicy([]).includes("script-src 'self';"), true);
});
