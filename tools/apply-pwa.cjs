'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const write = (file, content) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};
const replaceOnce = (file, from, to) => {
  const source = read(file);
  if (source.includes(to)) return;
  const index = source.indexOf(from);
  if (index < 0) throw new Error('Anchor not found in ' + file + ': ' + from.slice(0, 80));
  if (source.indexOf(from, index + from.length) >= 0) throw new Error('Anchor is not unique in ' + file);
  write(file, source.slice(0, index) + to + source.slice(index + from.length));
};

write(
  'client/manifest.webmanifest',
  JSON.stringify(
    {
      id: '/',
      name: 'Wobble Rush 3D',
      short_name: 'Wobble Rush',
      description: 'Мобильная 3D-игра с одиночными забегами и кооперативным приключением на двоих.',
      lang: 'ru',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      background_color: '#83dff0',
      theme_color: '#4b35b7',
      categories: ['games'],
      icons: [
        { src: '/icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
        { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
        { src: '/icons/icon-maskable.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' }
      ]
    },
    null,
    2
  ) + '\n'
);

const icon = size =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="' +
  size +
  '" height="' +
  size +
  '" viewBox="0 0 512 512" role="img" aria-label="Wobble Rush">\n' +
  '  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#6546d8"/><stop offset="1" stop-color="#2e1d86"/></linearGradient></defs>\n' +
  '  <rect width="512" height="512" rx="112" fill="url(#bg)"/>\n' +
  '  <circle cx="256" cy="224" r="116" fill="#ff4f91"/>\n' +
  '  <ellipse cx="256" cy="198" rx="78" ry="48" fill="#dffcff"/>\n' +
  '  <ellipse cx="229" cy="197" rx="18" ry="25" fill="#27315f"/><ellipse cx="283" cy="197" rx="18" ry="25" fill="#27315f"/>\n' +
  '  <path d="M228 340v86M284 340v86" stroke="#ff4f91" stroke-width="38" stroke-linecap="round"/>\n' +
  '  <path d="M165 304c-34 8-55 28-68 59M347 304c34 8 55 28 68 59" stroke="#ff9cc0" stroke-width="28" stroke-linecap="round" fill="none"/>\n' +
  '  <path d="M365 88l12 29 29 12-29 12-12 29-12-29-29-12 29-12z" fill="#fff7c7"/>\n' +
  '</svg>\n';
write('client/icons/icon-192.svg', icon(192));
write('client/icons/icon-512.svg', icon(512));
write(
  'client/icons/icon-maskable.svg',
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="Wobble Rush">\n' +
    '  <rect width="512" height="512" fill="#4b35b7"/>\n' +
    '  <circle cx="256" cy="225" r="102" fill="#ff4f91"/>\n' +
    '  <ellipse cx="256" cy="202" rx="68" ry="42" fill="#dffcff"/>\n' +
    '  <ellipse cx="232" cy="201" rx="15" ry="21" fill="#27315f"/><ellipse cx="280" cy="201" rx="15" ry="21" fill="#27315f"/>\n' +
    '  <path d="M232 326v70M280 326v70" stroke="#ff4f91" stroke-width="34" stroke-linecap="round"/>\n' +
    '  <path d="M351 111l10 24 24 10-24 10-10 24-10-24-24-10 24-10z" fill="#fff7c7"/>\n' +
    '</svg>\n'
);

write(
  'client/offline.html',
  '<!doctype html>\n' +
    '<html lang="ru">\n' +
    '  <head>\n' +
    '    <meta charset="utf-8" />\n' +
    '    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />\n' +
    '    <meta name="theme-color" content="#4b35b7" />\n' +
    '    <title>Wobble Rush · Нет сети</title>\n' +
    '    <style>\n' +
    '      :root{font-family:Inter,system-ui,sans-serif;color:#fff;background:#31218b;color-scheme:dark}*{box-sizing:border-box}body{min-height:100dvh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 50% 20%,#7659e8,#31218b 62%,#1d1656)}main{width:min(440px,100%);padding:32px;border:1px solid #ffffff2e;border-radius:28px;background:#16113db8;box-shadow:0 24px 80px #09061f80;text-align:center}i{display:grid;place-items:center;width:82px;height:82px;margin:0 auto 20px;border-radius:28px;background:#ff4f91;font-size:42px;font-style:normal}h1{margin:0 0 12px;font-size:clamp(28px,8vw,44px)}p{margin:0 0 24px;color:#d9d6ff;line-height:1.55}a{display:block;padding:16px 20px;border-radius:18px;background:#fff;color:#382794;text-decoration:none;font-weight:900;letter-spacing:.04em}small{display:block;margin-top:18px;color:#aaa4da}\n' +
    '    </style>\n' +
    '  </head>\n' +
    '  <body>\n' +
    '    <main>\n' +
    '      <i aria-hidden="true">☁</i>\n' +
    '      <h1>НЕТ СОЕДИНЕНИЯ</h1>\n' +
    '      <p>Wobble Rush уже установлен на устройстве, но для входа в аккаунт и сетевой игры сейчас нужен интернет.</p>\n' +
    '      <a href="/">ПОВТОРИТЬ ПОДКЛЮЧЕНИЕ</a>\n' +
    '      <small>Если сеть вернулась, откройте игру снова.</small>\n' +
    '    </main>\n' +
    '  </body>\n' +
    '</html>\n'
);

write(
  'client/pwa.css',
  '.pwa-connectivity,.pwa-update{position:fixed;z-index:1200;left:50%;width:min(560px,calc(100% - 24px));transform:translateX(-50%);border:1px solid #ffffff30;border-radius:18px;background:#18133ee8;color:#fff;box-shadow:0 18px 60px #08051f70;backdrop-filter:blur(14px)}\n' +
    '.pwa-connectivity{top:max(12px,env(safe-area-inset-top));display:flex;align-items:center;gap:12px;padding:11px 15px;font-size:13px}.pwa-connectivity b{color:#ffd56b;white-space:nowrap}.pwa-connectivity span{color:#dedaff}\n' +
    '.pwa-update{bottom:max(12px,env(safe-area-inset-bottom));display:grid;grid-template-columns:1fr auto;gap:8px 14px;align-items:center;padding:14px 16px}.pwa-update-copy{min-width:0}.pwa-update-copy b{display:block;font-size:13px;letter-spacing:.08em}.pwa-update-copy span{display:block;margin-top:3px;color:#c9c4ef;font-size:12px;line-height:1.35}.pwa-update .button{margin:0;min-height:42px;padding:10px 14px;white-space:nowrap}.pwa-update .button:disabled{opacity:.75}\n' +
    '#installApp{white-space:nowrap}\n' +
    '@media (max-width:600px){.pwa-update{grid-template-columns:1fr}.pwa-update .button{width:100%}.pwa-connectivity{align-items:flex-start}}\n' +
    '@media (display-mode:standalone){#installApp{display:none!important}}\n'
);

write(
  'client/service-worker.js',
  "'use strict';\n\n" +
    "const CACHE_NAME = 'wobble-pwa-v1';\n" +
    "const APP_SHELL = [\n" +
    "  '/',\n" +
    "  '/index.html',\n" +
    "  '/offline.html',\n" +
    "  '/styles.css',\n" +
    "  '/pwa.css',\n" +
    "  '/main.js',\n" +
    "  '/pwa-entry.js',\n" +
    "  '/core/pwa.js',\n" +
    "  '/manifest.webmanifest',\n" +
    "  '/icons/icon-192.svg',\n" +
    "  '/icons/icon-512.svg',\n" +
    "  '/icons/icon-maskable.svg'\n" +
    "];\n" +
    "const NETWORK_ONLY_PREFIXES = ['/api/', '/account', '/health', '/metrics', '/ws'];\n" +
    "const CACHEABLE_DESTINATIONS = new Set(['script', 'style', 'image', 'font', 'manifest', 'worker']);\n\n" +
    "self.addEventListener('install', event => {\n" +
    "  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));\n" +
    "});\n\n" +
    "self.addEventListener('activate', event => {\n" +
    "  event.waitUntil(\n" +
    "    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME && key.startsWith('wobble-pwa-')).map(key => caches.delete(key))))\n" +
    "  );\n" +
    "});\n\n" +
    "self.addEventListener('message', event => {\n" +
    "  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();\n" +
    "});\n\n" +
    "function networkOnly(url, request) {\n" +
    "  if (NETWORK_ONLY_PREFIXES.some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix))) return true;\n" +
    "  return request.destination === '' && request.mode !== 'navigate';\n" +
    "}\n\n" +
    "async function networkFirst(request, fallback = null) {\n" +
    "  const cache = await caches.open(CACHE_NAME);\n" +
    "  try {\n" +
    "    const response = await fetch(request);\n" +
    "    if (response.ok && request.mode !== 'navigate') await cache.put(request, response.clone());\n" +
    "    return response;\n" +
    "  } catch (error) {\n" +
    "    if (fallback) {\n" +
    "      const offline = await cache.match(fallback);\n" +
    "      if (offline) return offline;\n" +
    "    }\n" +
    "    const cached = await cache.match(request);\n" +
    "    if (cached) return cached;\n" +
    "    throw error;\n" +
    "  }\n" +
    "}\n\n" +
    "self.addEventListener('fetch', event => {\n" +
    "  const request = event.request;\n" +
    "  if (request.method !== 'GET') return;\n" +
    "  const url = new URL(request.url);\n" +
    "  if (url.origin !== self.location.origin || networkOnly(url, request)) return;\n" +
    "  if (request.mode === 'navigate') {\n" +
    "    event.respondWith(networkFirst(request, '/offline.html'));\n" +
    "    return;\n" +
    "  }\n" +
    "  if (!CACHEABLE_DESTINATIONS.has(request.destination)) return;\n" +
    "  event.respondWith(networkFirst(request));\n" +
    "});\n"
);

write(
  'client/core/pwa.js',
  "export function updateButtonLabel({ safe, requested }) {\n" +
    "  if (requested && !safe) return 'ОБНОВИМ ПОСЛЕ ЗАБЕГА';\n" +
    "  return safe ? 'ОБНОВИТЬ СЕЙЧАС' : 'ОБНОВИТЬ ПОСЛЕ ЗАБЕГА';\n" +
    "}\n\n" +
    "export class PwaController {\n" +
    "  constructor({ navigatorRef = globalThis.navigator, windowRef = globalThis, documentRef = globalThis.document, isSafeToReload = () => true, setIntervalImpl = globalThis.setInterval?.bind(globalThis), clearIntervalImpl = globalThis.clearInterval?.bind(globalThis) } = {}) {\n" +
    "    this.navigator = navigatorRef;\n" +
    "    this.window = windowRef;\n" +
    "    this.document = documentRef;\n" +
    "    this.isSafeToReload = isSafeToReload;\n" +
    "    this.setInterval = setIntervalImpl;\n" +
    "    this.clearInterval = clearIntervalImpl;\n" +
    "    this.waitingWorker = null;\n" +
    "    this.installPrompt = null;\n" +
    "    this.updateRequested = false;\n" +
    "    this.reloadStarted = false;\n" +
    "    this.pollTimer = null;\n" +
    "  }\n\n" +
    "  async start() {\n" +
    "    this.bindConnectivity();\n" +
    "    this.bindInstallPrompt();\n" +
    "    const serviceWorker = this.navigator?.serviceWorker;\n" +
    "    if (!serviceWorker?.register) return null;\n" +
    "    serviceWorker.addEventListener?.('controllerchange', () => this.handleControllerChange());\n" +
    "    try {\n" +
    "      const registration = await serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' });\n" +
    "      this.watchRegistration(registration);\n" +
    "      return registration;\n" +
    "    } catch (error) {\n" +
    "      console.warn('PWA registration failed', error);\n" +
    "      return null;\n" +
    "    }\n" +
    "  }\n\n" +
    "  bindConnectivity() {\n" +
    "    const render = () => {\n" +
    "      const banner = this.document?.getElementById?.('offlineBanner');\n" +
    "      if (!banner) return;\n" +
    "      banner.classList.toggle('hidden', this.navigator?.onLine !== false);\n" +
    "    };\n" +
    "    this.window?.addEventListener?.('online', render);\n" +
    "    this.window?.addEventListener?.('offline', render);\n" +
    "    render();\n" +
    "  }\n\n" +
    "  bindInstallPrompt() {\n" +
    "    const button = this.document?.getElementById?.('installApp');\n" +
    "    if (!button) return;\n" +
    "    button.addEventListener('click', () => this.promptInstall());\n" +
    "    this.window?.addEventListener?.('beforeinstallprompt', event => {\n" +
    "      event.preventDefault();\n" +
    "      this.installPrompt = event;\n" +
    "      if (!this.isStandalone()) button.classList.remove('hidden');\n" +
    "    });\n" +
    "    this.window?.addEventListener?.('appinstalled', () => {\n" +
    "      this.installPrompt = null;\n" +
    "      button.classList.add('hidden');\n" +
    "    });\n" +
    "    if (this.isStandalone()) button.classList.add('hidden');\n" +
    "  }\n\n" +
    "  isStandalone() {\n" +
    "    return Boolean(this.navigator?.standalone || this.window?.matchMedia?.('(display-mode: standalone)')?.matches);\n" +
    "  }\n\n" +
    "  async promptInstall() {\n" +
    "    const prompt = this.installPrompt;\n" +
    "    if (!prompt) return false;\n" +
    "    this.installPrompt = null;\n" +
    "    const button = this.document?.getElementById?.('installApp');\n" +
    "    button?.classList.add('hidden');\n" +
    "    await prompt.prompt?.();\n" +
    "    const choice = await prompt.userChoice?.catch?.(() => null);\n" +
    "    return choice?.outcome === 'accepted';\n" +
    "  }\n\n" +
    "  watchRegistration(registration) {\n" +
    "    if (!registration) return;\n" +
    "    if (registration.waiting && this.navigator?.serviceWorker?.controller) this.offerUpdate(registration.waiting);\n" +
    "    registration.addEventListener?.('updatefound', () => {\n" +
    "      const worker = registration.installing;\n" +
    "      if (!worker) return;\n" +
    "      worker.addEventListener?.('statechange', () => {\n" +
    "        if (worker.state === 'installed' && this.navigator?.serviceWorker?.controller) this.offerUpdate(worker);\n" +
    "      });\n" +
    "    });\n" +
    "  }\n\n" +
    "  offerUpdate(worker) {\n" +
    "    this.waitingWorker = worker;\n" +
    "    const banner = this.document?.getElementById?.('updateBanner');\n" +
    "    const button = this.document?.getElementById?.('applyUpdate');\n" +
    "    banner?.classList.remove('hidden');\n" +
    "    if (!button) return;\n" +
    "    button.disabled = false;\n" +
    "    button.textContent = updateButtonLabel({ safe: this.isSafeToReload(), requested: false });\n" +
    "    if (!button.dataset.pwaBound) {\n" +
    "      button.dataset.pwaBound = '1';\n" +
    "      button.addEventListener('click', () => this.requestUpdate());\n" +
    "    }\n" +
    "  }\n\n" +
    "  requestUpdate() {\n" +
    "    if (!this.waitingWorker) return false;\n" +
    "    this.updateRequested = true;\n" +
    "    if (this.isSafeToReload()) return this.activateWaiting();\n" +
    "    const button = this.document?.getElementById?.('applyUpdate');\n" +
    "    if (button) {\n" +
    "      button.textContent = updateButtonLabel({ safe: false, requested: true });\n" +
    "      button.disabled = true;\n" +
    "    }\n" +
    "    if (!this.pollTimer && this.setInterval) {\n" +
    "      this.pollTimer = this.setInterval(() => {\n" +
    "        if (this.updateRequested && this.waitingWorker && this.isSafeToReload()) this.activateWaiting();\n" +
    "      }, 500);\n" +
    "    }\n" +
    "    return true;\n" +
    "  }\n\n" +
    "  activateWaiting() {\n" +
    "    if (!this.waitingWorker || !this.updateRequested) return false;\n" +
    "    if (this.pollTimer && this.clearInterval) this.clearInterval(this.pollTimer);\n" +
    "    this.pollTimer = null;\n" +
    "    const button = this.document?.getElementById?.('applyUpdate');\n" +
    "    if (button) {\n" +
    "      button.textContent = 'ОБНОВЛЯЕМ…';\n" +
    "      button.disabled = true;\n" +
    "    }\n" +
    "    this.waitingWorker.postMessage({ type: 'SKIP_WAITING' });\n" +
    "    return true;\n" +
    "  }\n\n" +
    "  handleControllerChange() {\n" +
    "    if (!this.updateRequested || this.reloadStarted || !this.isSafeToReload()) return;\n" +
    "    this.reloadStarted = true;\n" +
    "    this.window?.location?.reload?.();\n" +
    "  }\n" +
    "}\n"
);

write(
  'client/pwa-entry.js',
  "import { PwaController } from './core/pwa.js';\n\n" +
    "const pwa = new PwaController({\n" +
    "  isSafeToReload: () => !globalThis.__WOBBLE_GAME__?.running\n" +
    "});\n" +
    "globalThis.__WOBBLE_PWA__ = pwa;\n" +
    "pwa.start();\n"
);

write(
  'server/pwa.test.mjs',
  "import test from 'node:test';\n" +
    "import assert from 'node:assert/strict';\n" +
    "import { readFile } from 'node:fs/promises';\n\n" +
    "test('manifest делает Wobble Rush устанавливаемым standalone PWA', async () => {\n" +
    "  const manifest = JSON.parse(await readFile('client/manifest.webmanifest', 'utf8'));\n" +
    "  assert.equal(manifest.start_url, '/');\n" +
    "  assert.equal(manifest.scope, '/');\n" +
    "  assert.equal(manifest.display, 'standalone');\n" +
    "  assert.equal(manifest.theme_color, '#4b35b7');\n" +
    "  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));\n" +
    "  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));\n" +
    "  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));\n" +
    "});\n\n" +
    "test('service worker не кэширует API/health/ws и не активирует update самовольно', async () => {\n" +
    "  const source = await readFile('client/service-worker.js', 'utf8');\n" +
    "  assert.match(source, /NETWORK_ONLY_PREFIXES = \['\\/api\\/', '\\/account', '\\/health', '\\/metrics', '\\/ws'\]/);\n" +
    "  assert.match(source, /event\.data\?\.type === 'SKIP_WAITING'/);\n" +
    "  const installBlock = source.slice(source.indexOf(\"addEventListener('install'\"), source.indexOf(\"addEventListener('activate'\"));\n" +
    "  assert.doesNotMatch(installBlock, /skipWaiting/);\n" +
    "});\n"
);

write(
  'server/pwaClient.test.mjs',
  "import test from 'node:test';\n" +
    "import assert from 'node:assert/strict';\n" +
    "import { PwaController, updateButtonLabel } from '../client/core/pwa.js';\n\n" +
    "function classList() {\n" +
    "  const values = new Set(['hidden']);\n" +
    "  return { add: value => values.add(value), remove: value => values.delete(value), toggle: (value, force) => (force ? values.add(value) : values.delete(value)), contains: value => values.has(value) };\n" +
    "}\n" +
    "function element() {\n" +
    "  return { classList: classList(), dataset: {}, disabled: false, textContent: '', listeners: new Map(), addEventListener(type, fn) { this.listeners.set(type, fn); } };\n" +
    "}\n\n" +
    "test('update label явно откладывает reload во время забега', () => {\n" +
    "  assert.equal(updateButtonLabel({ safe: false, requested: false }), 'ОБНОВИТЬ ПОСЛЕ ЗАБЕГА');\n" +
    "  assert.equal(updateButtonLabel({ safe: true, requested: false }), 'ОБНОВИТЬ СЕЙЧАС');\n" +
    "  assert.equal(updateButtonLabel({ safe: false, requested: true }), 'ОБНОВИМ ПОСЛЕ ЗАБЕГА');\n" +
    "});\n\n" +
    "test('waiting service worker получает SKIP_WAITING только после окончания активного забега', () => {\n" +
    "  const updateBanner = element();\n" +
    "  const applyUpdate = element();\n" +
    "  const installApp = element();\n" +
    "  const offlineBanner = element();\n" +
    "  const elements = { updateBanner, applyUpdate, installApp, offlineBanner };\n" +
    "  const documentRef = { getElementById: id => elements[id] || null };\n" +
    "  const messages = [];\n" +
    "  const waiting = { postMessage: message => messages.push(message) };\n" +
    "  let running = true;\n" +
    "  let poll = null;\n" +
    "  const controller = new PwaController({\n" +
    "    navigatorRef: { onLine: true },\n" +
    "    documentRef,\n" +
    "    windowRef: {},\n" +
    "    isSafeToReload: () => !running,\n" +
    "    setIntervalImpl: fn => { poll = fn; return 7; },\n" +
    "    clearIntervalImpl: () => {}\n" +
    "  });\n" +
    "  controller.offerUpdate(waiting);\n" +
    "  assert.equal(controller.requestUpdate(), true);\n" +
    "  assert.deepEqual(messages, []);\n" +
    "  assert.equal(applyUpdate.textContent, 'ОБНОВИМ ПОСЛЕ ЗАБЕГА');\n" +
    "  running = false;\n" +
    "  poll();\n" +
    "  assert.deepEqual(messages, [{ type: 'SKIP_WAITING' }]);\n" +
    "});\n"
);

write(
  'e2e/pwa.spec.js',
  "import { test, expect } from '@playwright/test';\n\n" +
    "test('PWA регистрируется, не кэширует health и показывает offline shell', async ({ page, context }) => {\n" +
    "  await page.goto('/');\n" +
    "  const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());\n" +
    "  expect(manifest.display).toBe('standalone');\n" +
    "  expect(manifest.start_url).toBe('/');\n" +
    "  expect(manifest.icons.some(icon => icon.purpose === 'maskable')).toBeTruthy();\n" +
    "\n" +
    "  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);\n" +
    "  expect(scope).toBe('http://127.0.0.1:4173/');\n" +
    "  await page.reload();\n" +
    "  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));\n" +
    "  await page.evaluate(async () => { await fetch('/health'); });\n" +
    "  const cached = await page.evaluate(async () => {\n" +
    "    const urls = [];\n" +
    "    for (const name of await caches.keys()) {\n" +
    "      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);\n" +
    "    }\n" +
    "    return urls;\n" +
    "  });\n" +
    "  expect(cached.some(url => url.includes('/health'))).toBeFalsy();\n" +
    "\n" +
    "  await context.setOffline(true);\n" +
    "  await page.goto('/offline-check');\n" +
    "  await expect(page.getByRole('heading', { name: 'НЕТ СОЕДИНЕНИЯ' })).toBeVisible();\n" +
    "  await expect(page.getByRole('link', { name: 'ПОВТОРИТЬ ПОДКЛЮЧЕНИЕ' })).toBeVisible();\n" +
    "  await context.setOffline(false);\n" +
    "});\n"
);

replaceOnce(
  'client/index.html',
  '    <meta name="theme-color" content="#4b35b7" />\n',
  '    <meta name="theme-color" content="#4b35b7" />\n' +
    '    <meta name="application-name" content="Wobble Rush" />\n' +
    '    <meta name="apple-mobile-web-app-capable" content="yes" />\n' +
    '    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />\n' +
    '    <link rel="manifest" href="manifest.webmanifest" />\n' +
    '    <link rel="apple-touch-icon" href="icons/icon-192.svg" />\n'
);
replaceOnce(
  'client/index.html',
  '    <link rel="stylesheet" href="styles.css" />\n',
  '    <link rel="stylesheet" href="styles.css" />\n    <link rel="stylesheet" href="pwa.css" />\n'
);
replaceOnce(
  'client/index.html',
  '    <div id="error" class="toast toast-error hidden" role="alert"></div>\n',
  '    <div id="error" class="toast toast-error hidden" role="alert"></div>\n' +
    '    <div id="offlineBanner" class="pwa-connectivity hidden" role="status" aria-live="polite">\n' +
    '      <b>НЕТ СЕТИ</b><span>Офлайн-режим активен · сетевые функции восстановятся автоматически.</span>\n' +
    '    </div>\n' +
    '    <div id="updateBanner" class="pwa-update hidden" role="status" aria-live="polite">\n' +
    '      <div class="pwa-update-copy"><b>ДОСТУПНО ОБНОВЛЕНИЕ</b><span>Новая версия не перезагрузит игру посреди забега.</span></div>\n' +
    '      <button id="applyUpdate" class="button button-secondary" type="button">ОБНОВИТЬ ПОСЛЕ ЗАБЕГА</button>\n' +
    '    </div>\n'
);
replaceOnce(
  'client/index.html',
  '        <div class="menu-footer">\n          <button id="quality"',
  '        <div class="menu-footer">\n          <button id="installApp" class="icon-button hidden" type="button">УСТАНОВИТЬ</button>\n          <button id="quality"'
);
replaceOnce(
  'client/index.html',
  '    <script type="module" src="main.js"></script>\n',
  '    <script type="module" src="main.js"></script>\n    <script type="module" src="pwa-entry.js"></script>\n'
);

replaceOnce(
  'server/index.js',
  '      ["script-src \'self\'", ...INLINE_SCRIPT_HASHES].join(\' \'),\n      "style-src \'self\' \'unsafe-inline\'",',
  '      ["script-src \'self\'", ...INLINE_SCRIPT_HASHES].join(\' \'),\n      "worker-src \'self\'",\n      "style-src \'self\' \'unsafe-inline\'",'
);
replaceOnce(
  'server/index.js',
  "      if (/\\.(js|css|html)$/.test(file)) res.setHeader('Cache-Control', NO_CACHE);",
  "      if (/\\.(js|css|html|webmanifest)$/.test(file)) res.setHeader('Cache-Control', NO_CACHE);"
);

replaceOnce(
  'package.json',
  'server/backup.test.mjs server/migrations.test.mjs',
  'server/backup.test.mjs server/pwa.test.mjs server/migrations.test.mjs'
);
replaceOnce(
  'package.json',
  'server/settings.test.mjs\",',
  'server/settings.test.mjs server/pwaClient.test.mjs\",'
);

console.log('PWA integration applied');
