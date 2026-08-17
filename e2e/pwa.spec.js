import { test, expect } from '@playwright/test';

test('PWA регистрируется, предпочитает landscape, не кэширует health и показывает offline shell', async ({
  page,
  context
}) => {
  await page.goto('/');
  const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  // Fullscreen manifest mode остаётся intentionally deferred до smoke на реальных installed PWA.
  // DOM Fullscreen API покрывается отдельно и не должен подменять эту проверку.
  expect(manifest.display).toBe('standalone');
  expect(manifest.orientation).toBe('landscape');
  expect(manifest.start_url).toBe('/');
  expect(manifest.icons.some(icon => icon.purpose === 'maskable')).toBeTruthy();

  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe('http://127.0.0.1:4173/');
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.evaluate(async () => {
    await fetch('/health');
  });
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });
  expect(cached.some(url => url.includes('/health'))).toBeFalsy();

  await context.setOffline(true);
  await page.goto('/offline-check');
  await expect(page.getByRole('heading', { name: 'НЕТ СОЕДИНЕНИЯ' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ПОВТОРИТЬ ПОДКЛЮЧЕНИЕ' })).toBeVisible();
  await context.setOffline(false);
});
