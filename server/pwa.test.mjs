import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('manifest делает Wobble Rush устанавливаемым standalone PWA', async () => {
  const manifest = JSON.parse(await readFile('client/manifest.webmanifest', 'utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#4b35b7');
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
  assert.ok(manifest.icons.every(icon => icon.type === 'image/png'));
});

test('service worker не кэширует API/health/ws и не активирует update самовольно', async () => {
  const source = await readFile('client/service-worker.js', 'utf8');
  assert.ok(
    source.includes("const NETWORK_ONLY_PREFIXES = ['/api/', '/account', '/health', '/metrics', '/ws'];")
  );
  assert.ok(source.includes("event.data?.type === 'SKIP_WAITING'"));
  assert.ok(source.includes('self.clients.claim()'));
  const installBlock = source.slice(
    source.indexOf("addEventListener('install'"),
    source.indexOf("addEventListener('activate'")
  );
  assert.doesNotMatch(installBlock, /skipWaiting/);
});
