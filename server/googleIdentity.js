const crypto = require('crypto');

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const DEFAULT_CACHE_MS = 60 * 60 * 1000;

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function cacheLifetime(response) {
  const header = response.headers?.get?.('cache-control') || '';
  const match = header.match(/max-age=(\d+)/i);
  const seconds = Number(match?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_CACHE_MS;
}

class GoogleIdentityVerifier {
  constructor({ clientId, fetchImpl = globalThis.fetch, jwksUrl = GOOGLE_JWKS_URL } = {}) {
    this.clientId = String(clientId || '').trim();
    this.fetchImpl = fetchImpl;
    this.jwksUrl = jwksUrl;
    this.keys = new Map();
    this.keysExpireAt = 0;
  }

  get enabled() {
    return Boolean(this.clientId);
  }

  async refreshKeys(now = Date.now()) {
    if (typeof this.fetchImpl !== 'function') throw new Error('Google JWKS fetch недоступен');
    const response = await this.fetchImpl(this.jwksUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Google JWKS ответил ${response.status}`);
    const body = await response.json();
    const next = new Map();
    for (const jwk of body?.keys || []) {
      if (jwk?.kid && jwk?.kty === 'RSA' && jwk?.alg === 'RS256') next.set(jwk.kid, jwk);
    }
    if (!next.size) throw new Error('Google JWKS не содержит RS256 ключей');
    this.keys = next;
    this.keysExpireAt = now + cacheLifetime(response);
  }

  async keyFor(kid, now = Date.now()) {
    if (!this.keys.has(kid) || now >= this.keysExpireAt) await this.refreshKeys(now);
    let jwk = this.keys.get(kid);
    // Google может ротировать ключ между двумя запросами: если cache ещё жив, но kid новый,
    // делаем один принудительный refresh вместо немедленного отказа.
    if (!jwk) {
      this.keysExpireAt = 0;
      await this.refreshKeys(now);
      jwk = this.keys.get(kid);
    }
    return jwk || null;
  }

  async verify(credential, { now = Date.now() } = {}) {
    if (!this.enabled) return { ok: false, reason: 'google-disabled' };
    if (typeof credential !== 'string' || credential.length > 16_384) return { ok: false, reason: 'invalid-token' };

    const parts = credential.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'invalid-token' };
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodePart(encodedHeader);
    const payload = decodePart(encodedPayload);
    if (!header || !payload || header.alg !== 'RS256' || !header.kid)
      return { ok: false, reason: 'invalid-token' };

    const jwk = await this.keyFor(header.kid, now);
    if (!jwk) return { ok: false, reason: 'unknown-key' };

    let signature;
    let key;
    try {
      signature = Buffer.from(encodedSignature, 'base64url');
      key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch {
      return { ok: false, reason: 'invalid-token' };
    }
    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key,
      signature
    );
    if (!verified) return { ok: false, reason: 'bad-signature' };

    const seconds = Math.floor(now / 1000);
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audience.includes(this.clientId)) return { ok: false, reason: 'wrong-audience' };
    if (!GOOGLE_ISSUERS.has(payload.iss)) return { ok: false, reason: 'wrong-issuer' };
    if (!Number.isFinite(payload.exp) || payload.exp <= seconds)
      return { ok: false, reason: 'expired' };
    if (Number.isFinite(payload.nbf) && payload.nbf > seconds + 60)
      return { ok: false, reason: 'not-active' };
    if (Number.isFinite(payload.iat) && payload.iat > seconds + 300)
      return { ok: false, reason: 'issued-in-future' };
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255)
      return { ok: false, reason: 'missing-subject' };

    return {
      ok: true,
      subject: payload.sub,
      name: typeof payload.name === 'string' ? payload.name : '',
      email: typeof payload.email === 'string' ? payload.email : '',
      emailVerified: payload.email_verified === true
    };
  }
}

module.exports = { GoogleIdentityVerifier, GOOGLE_JWKS_URL, GOOGLE_ISSUERS };
