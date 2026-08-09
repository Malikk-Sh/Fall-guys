import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GoogleIdentityVerifier } = require('./googleIdentity');

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function fixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  Object.assign(jwk, { kid: 'test-key', alg: 'RS256', use: 'sig' });
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: name => (name.toLowerCase() === 'cache-control' ? 'public, max-age=3600' : null) },
    json: async () => ({ keys: [jwk] })
  });
  const sign = payload => {
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid });
    const body = encode(payload);
    const input = `${header}.${body}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
    return `${input}.${signature}`;
  };
  return { fetchImpl, sign };
}

test('Google verifier проверяет подпись issuer audience expiry и subject', async () => {
  const { fetchImpl, sign } = fixture();
  const verifier = new GoogleIdentityVerifier({ clientId: 'wobble-client', fetchImpl });
  const now = 1_800_000_000_000;
  const credential = sign({
    iss: 'https://accounts.google.com',
    aud: 'wobble-client',
    sub: '10987654321',
    exp: Math.floor(now / 1000) + 600,
    iat: Math.floor(now / 1000),
    name: 'Google Player',
    email: 'player@example.test',
    email_verified: true
  });

  assert.deepEqual(await verifier.verify(credential, { now }), {
    ok: true,
    subject: '10987654321',
    name: 'Google Player',
    email: 'player@example.test',
    emailVerified: true
  });
});

test('Google verifier отклоняет token другого OAuth client', async () => {
  const { fetchImpl, sign } = fixture();
  const verifier = new GoogleIdentityVerifier({ clientId: 'wobble-client', fetchImpl });
  const now = 1_800_000_000_000;
  const credential = sign({
    iss: 'accounts.google.com',
    aud: 'attacker-client',
    sub: 'subject',
    exp: Math.floor(now / 1000) + 600
  });
  assert.equal((await verifier.verify(credential, { now })).reason, 'wrong-audience');
});

test('Google verifier отклоняет истёкший token', async () => {
  const { fetchImpl, sign } = fixture();
  const verifier = new GoogleIdentityVerifier({ clientId: 'wobble-client', fetchImpl });
  const now = 1_800_000_000_000;
  const credential = sign({
    iss: 'accounts.google.com',
    aud: 'wobble-client',
    sub: 'subject',
    exp: Math.floor(now / 1000) - 1
  });
  assert.equal((await verifier.verify(credential, { now })).reason, 'expired');
});
