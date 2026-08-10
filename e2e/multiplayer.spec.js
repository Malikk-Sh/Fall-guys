import { test, expect } from '@playwright/test';

// Имя игрока живёт в аккаунте, а не отдельным полем в меню. Задаём его так же, как игрок: открываем
// окно аккаунта, вводим имя, сохраняем.
async function setPlayerName(page, name) {
  // Ждём, пока аккаунт войдёт: до этого переименовывать нечего, и попытка молча ничего не сделает.
  await expect(page.locator('#accountName')).not.toHaveText(/^(…|без аккаунта)$/, { timeout: 20_000 });
  await page.locator('#accountChip').click();
  await page.locator('#accountRename').fill(name);
  await page.locator('#accountSave').click();
  await expect(page.locator('#accountName')).toHaveText(name, { timeout: 10_000 });
  await page.locator('#accountClose').click();
}

// Получаем косметику через тот же fake rewarded provider, который предназначен для dev/E2E.
// Никакого тестового bypass ownership: grant пишет entitlement в server inventory, а equip проходит
// обычную authenticated /api/cosmetics/equip проверку.
async function equipServerCosmetic(page, key) {
  const result = await page.evaluate(async idempotencyKey => {
    const grantResponse = await fetch('/api/rewards/dev', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey })
    });
    const grant = await grantResponse.json();
    if (!grantResponse.ok) return { error: `grant:${grant.error || grantResponse.status}` };

    const slots = { 'neon-visor': 'visor', 'party-antenna': 'antenna' };
    const slot = slots[grant.cosmeticId];
    if (!slot) return { error: `unknown-reward:${grant.cosmeticId}` };

    const equipResponse = await fetch('/api/cosmetics/equip', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot, cosmeticId: grant.cosmeticId })
    });
    const equipped = await equipResponse.json();
    if (!equipResponse.ok) return { error: `equip:${equipped.error || equipResponse.status}` };
    return { id: grant.cosmeticId, slot };
  }, key);

  expect(result.error).toBeUndefined();
  expect(result.id).toBeTruthy();
  return result;
}

test('два браузера видят server-owned косметику друг друга и входят в кооп-комнату', async ({
  browser
}, testInfo) => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, extraHTTPHeaders } =
    testInfo.project.use;
  const device = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, extraHTTPHeaders };
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
  await setPlayerName(host, 'Хост E2E');
  const hostCosmetic = await equipServerCosmetic(
    host,
    `social-host-${testInfo.project.name}-${Date.now()}`
  );
  await host.locator('[data-mode="coop"]').click();
  await host.locator('#coopCreate').click();
  await expect(host.locator('#lobby')).toBeVisible();
  const code = (await host.locator('#roomCode').textContent()).trim();
  expect(code).toMatch(/^[A-Z0-9]{5}$/);

  await guest.goto(`/?room=${code}&mode=coop`);
  await expect(guest.locator('[data-mode="coop"]')).toHaveClass(/active/);
  await expect(guest.locator('#coopCode')).toHaveValue(code);
  await setPlayerName(guest, 'Гость E2E');
  const guestCosmetic = await equipServerCosmetic(
    guest,
    `social-guest-${testInfo.project.name}-${Date.now()}`
  );
  await guest.locator('#coopJoin').click();

  await expect(host.locator('#players .player-row')).toHaveCount(2);
  await expect(guest.locator('#players .player-row')).toHaveCount(2);
  await expect(host.locator('#players')).toContainText('Гость E2E');
  await expect(guest.locator('#players')).toContainText('Хост E2E');

  // Проверяем именно чужую строку. Data-атрибуты выставляет UI после нормализации server public
  // loadout через общий каталог — это стабильнее pixel screenshot и одновременно доказывает, что
  // оба независимых browser context получили экипировку другого аккаунта по сети.
  const guestSeenByHost = host.locator('#players .player-row').filter({ hasText: 'Гость E2E' });
  const hostSeenByGuest = guest.locator('#players .player-row').filter({ hasText: 'Хост E2E' });
  await expect(guestSeenByHost).toHaveAttribute(`data-cosmetic-${guestCosmetic.slot}`, guestCosmetic.id);
  await expect(hostSeenByGuest).toHaveAttribute(`data-cosmetic-${hostCosmetic.slot}`, hostCosmetic.id);
  await expect(guestSeenByHost.locator('.player-cosmetics')).not.toHaveText('КЛАССИКА');
  await expect(hostSeenByGuest.locator('.player-cosmetics')).not.toHaveText('КЛАССИКА');

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
