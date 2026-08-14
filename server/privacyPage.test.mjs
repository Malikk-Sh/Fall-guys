import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        headers: { accept: 'text/html' }
      },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
  });
}

test('privacy policy is public, canonical and linked from the game', async t => {
  const homepage = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
  const policy = fs.readFileSync(path.join(root, 'client', 'privacy', 'index.html'), 'utf8');

  assert.match(homepage, /href="\/privacy\/"/);
  assert.match(policy, /<link rel="canonical" href="https:\/\/wobbles\.ru\/privacy\/" \/>/);
  assert.match(policy, /Google Identity Services/);
  assert.match(policy, /openid/);
  assert.match(policy, /userinfo\.email|<code>email<\/code>/);
  assert.match(policy, /profile/);
  assert.doesNotMatch(policy, /<script\b/i);
  assert.doesNotMatch(policy, /GOOGLE_CLIENT_SECRET|client secret/i);

  const core = require('./index.js');
  if (!core.server.listening) {
    await new Promise((resolve, reject) => {
      core.server.once('error', reject);
      core.server.listen(0, '127.0.0.1', resolve);
    });
  }
  t.after(
    () =>
      new Promise(resolve => {
        if (!core.server.listening) return resolve();
        core.server.close(() => resolve());
      })
  );

  const address = core.server.address();
  const port = Number(address?.port);
  assert.ok(Number.isSafeInteger(port) && port > 0);

  const redirect = await request(port, '/privacy');
  assert.equal(redirect.status, 301);
  assert.match(String(redirect.headers.location || ''), /\/privacy\/$/);

  const page = await request(port, '/privacy/');
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-type'] || ''), /^text\/html/);
  assert.match(page.body, /Политика конфиденциальности/);
  assert.match(page.body, /Privacy Policy/);
  assert.match(String(page.headers['content-security-policy'] || ''), /default-src 'self'/);
});
