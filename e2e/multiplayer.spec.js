import { test, expect } from '@playwright/test';

test('два браузера входят в кооп-комнату по режимной ссылке и готовы к старту', async ({
  browser
}, testInfo) => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = testInfo.project.use;
  const device = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
  const hostContext = await browser.newContext(device);
  const guestContext = await browser.newContext(device);
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto('/');
  await expect(host.locator('html')).toHaveAttribute('lang', 'ru');
  await expect(host.locator('meta[name="viewport"]')).not.toHaveAttribute('content', /user-scalable=no/);
  await expect(host.getByRole('tab', { name: 'КООП НА ДВОИХ' })).toBeVisible();
  if (testInfo.project.name === 'mobile-chromium') {
    expect(await host.evaluate(() => navigator.maxTouchPoints)).toBeGreaterThan(0);
  }
  await host.locator('[data-mode="coop"]').click();
  await host.locator('#coopName').fill('Хост E2E');
  await host.locator('#coopCreate').click();
  await expect(host.locator('#lobby')).toBeVisible();
  const code = (await host.locator('#roomCode').textContent()).trim();
  expect(code).toMatch(/^[A-Z0-9]{5}$/);

  await guest.goto(`/?room=${code}&mode=coop`);
  await expect(guest.locator('[data-mode="coop"]')).toHaveClass(/active/);
  await expect(guest.locator('#coopCode')).toHaveValue(code);
  await guest.locator('#coopName').fill('Гость E2E');
  await guest.locator('#coopJoin').click();

  await expect(host.locator('#players .player-row')).toHaveCount(2);
  await expect(guest.locator('#players .player-row')).toHaveCount(2);
  await expect(host.locator('#players')).toContainText('Гость E2E');
  await expect(guest.locator('#players')).toContainText('Хост E2E');

  await host.locator('#ready').click();
  await guest.locator('#ready').click();
  await expect(host.locator('#players .ready')).toHaveCount(2);
  await expect(host.locator('#start')).toBeEnabled();

  const resumeToken = await guest.evaluate(() => sessionStorage.getItem('wobble-session'));
  expect(resumeToken).toBeTruthy();
  await host.locator('#start').click();
  await expect(host.locator('#hud')).toBeVisible({ timeout: 10_000 });
  await expect(guest.locator('#hud')).toBeVisible({ timeout: 10_000 });

  // Полная перезагрузка создаёт новый WebSocket и новый экземпляр игры. Сервер должен вернуть
  // прежнего игрока в тот же матч по сохранённому токену, а не создать дубль или открыть меню.
  await guest.reload();
  await expect(guest.locator('#hud')).toBeVisible({ timeout: 10_000 });
  await expect(guest.locator('#linkOverlay')).toBeHidden();
  expect(await guest.evaluate(() => sessionStorage.getItem('wobble-session'))).toBe(resumeToken);

  await hostContext.close();
  await guestContext.close();
});
