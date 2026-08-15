// Сбивание с ног между двумя браузерами.
//
// Сбивание — новая механика: сильный контакт не замораживает физику, но на 1.05–1.65 с отнимает
// управление, и персонаж процедурно обмякает. Проверять её было негде: единственный браузерный
// сценарий на двоих — полный матч, и он идёт настоящее время до финиша.
//
// Здесь проверяется ровно то, что нельзя увидеть со стороны сервера: что состояние пересекает
// сетевую границу и что второй КЛИЕНТ его видит. Всё остальное про сбивание — длительность, потеря
// управления, иммунитет после подъёма — покрыто server/knockdown.test.mjs на самой физике, и
// повторять это браузером незачем.
//
// Заканчивать сценарий прохождением трассы тоже незачем: за ход матча отвечает full-match.spec.js.
// Этот тест намеренно короткий — он про одно событие.

import { test, expect } from '@playwright/test';

// Границы из client/game/Player.js (KNOCKDOWN_MIN_TIME / KNOCKDOWN_MAX_TIME) плюс запас на
// пересылку и на просевший FPS раннера.
const KNOCKDOWN_MIN_MS = 1050;
const RECOVERY_TIMEOUT_MS = 6000;

async function setPlayerName(page, name) {
  await expect(page.locator('#accountName')).not.toHaveText('…', { timeout: 20_000 });
  await page.locator('#accountChip').click();
  await expect(page.locator('#account')).toBeVisible();
  if ((await page.locator('#accountName').textContent())?.trim() === 'ГОСТЬ') {
    await page.locator('#accountSignInFallback').click();
    await expect(page.locator('#accountName')).not.toHaveText('ГОСТЬ', { timeout: 20_000 });
  }
  await page.locator('#accountRename').fill(name);
  await page.locator('#accountSave').click();
  await expect(page.locator('#accountName')).toHaveText(name, { timeout: 10_000 });
  await page.locator('#accountClose').click();
}

// Состояние соперника глазами наблюдателя: берётся из того же буфера снапшотов, по которому
// клиент рисует удалённых игроков. Это и есть «увидел», а не внутреннее знание страницы.
const remoteState = async (page, otherId) =>
  page.evaluate(id => {
    const net = window.__WOBBLE_GAME__?.net;
    return net?.snapshots?.sample(id, net.renderTime())?.state ?? null;
  }, otherId);

test.describe('сбивание с ног', () => {
  test.setTimeout(120_000);

  // Только десктопный проект: сценарий про сетевое состояние, а не про управление с телефона, и
  // второй прогон на мобильном наборе ничего нового не проверил бы.
  const desktopOnly = testInfo =>
    test.skip(testInfo.project.name !== 'chromium', 'сценарий про сеть, а не про способ ввода');

  test('сбитый теряет управление, соперник это видит, и через секунду с небольшим он встаёт', async ({
    browser
  }, testInfo) => {
    desktopOnly(testInfo);

    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, extraHTTPHeaders } =
      testInfo.project.use;
    const context = () =>
      browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, extraHTTPHeaders });
    const [hostContext, guestContext] = await Promise.all([context(), context()]);
    const [host, guest] = await Promise.all([hostContext.newPage(), guestContext.newPage()]);
    test.info().annotations.push({ type: 'scenario', description: 'два клиента, один сбит' });

    try {
      await host.goto('/');
      await setPlayerName(host, 'Сбитый');
      await host.locator('#difficulty').selectOption('easy');
      await host.locator('[data-mode="multi"]').click();
      await host.locator('#create').click();
      await expect(host.locator('#lobby')).toBeVisible();
      const code = (await host.locator('#roomCode').textContent()).trim();

      await guest.goto('/');
      await setPlayerName(guest, 'Свидетель');
      await guest.locator('[data-mode="multi"]').click();
      await guest.locator('#code').fill(code);
      await guest.locator('#join').click();
      await expect(guest.locator('#lobby')).toBeVisible();

      await expect(host.locator('#players .player-row')).toHaveCount(2);
      await host.locator('#ready').click();
      await guest.locator('#ready').click();
      await expect(host.locator('#players .ready')).toHaveCount(2);
      await host.locator('#start').click();
      await expect(host.locator('#hud')).toBeVisible({ timeout: 20_000 });
      await expect(guest.locator('#hud')).toBeVisible({ timeout: 20_000 });

      // Ждём, пока забег действительно пойдёт: до конца отсчёта состояние не рассылается.
      await host.waitForFunction(
        () => window.__WOBBLE_GAME__?.player && window.__WOBBLE_GAME__?.net?.matchId,
        {
          timeout: 20_000
        }
      );
      const hostId = await host.evaluate(() => window.__WOBBLE_GAME__.net.id);
      await guest.waitForFunction(
        id => window.__WOBBLE_GAME__?.net?.snapshots?.sample(id, window.__WOBBLE_GAME__.net.renderTime()),
        hostId,
        { timeout: 20_000 }
      );

      // Удар.
      //
      // Вызывается тот же метод, что вызывают препятствия трассы (см. Course.interact). Ловить
      // настоящий контакт с вращающейся балкой в браузере значило бы сделать тест лотереей: момент
      // зависит от FPS раннера. Здесь важно не КАК прилетело, а что происходит после.
      const knocked = await host.evaluate(() => window.__WOBBLE_GAME__.player.knockDown(0.5));
      expect(knocked, 'удар прошёл').toBe(true);
      const knockedAt = Date.now();

      // Сбитый действительно потерял управление: физика вернула состояние knockdown.
      await expect
        .poll(() => host.evaluate(() => window.__WOBBLE_GAME__.player.snapshot().state), {
          timeout: 5000
        })
        .toBe('knockdown');

      // И это увидел ВТОРОЙ клиент — то самое, ради чего сценарий браузерный.
      await expect
        .poll(() => remoteState(guest, hostId), { timeout: 5000, message: 'соперник видит сбитого' })
        .toBe('knockdown');

      // Пока сбит, управление не работает: «вперёд» не разгоняет.
      await host.keyboard.down('KeyW');
      const speedWhileDown = await host.evaluate(() => {
        const v = window.__WOBBLE_GAME__.player.velocity;
        return Math.hypot(v.x, v.z);
      });
      await host.keyboard.up('KeyW');

      // Подъём. Проверяется и то, что он вообще происходит, и то, что происходит НЕ мгновенно:
      // сбивание без длительности не отличалось бы от лёгкого толчка.
      await expect
        .poll(() => host.evaluate(() => window.__WOBBLE_GAME__.player.knockdownTimer), {
          timeout: RECOVERY_TIMEOUT_MS
        })
        .toBe(0);
      const downFor = Date.now() - knockedAt;
      expect(downFor, `лежал ${downFor} мс — не меньше положенного`).toBeGreaterThanOrEqual(KNOCKDOWN_MIN_MS);

      // Управление вернулось: тот же «вперёд» теперь разгоняет.
      await host.keyboard.down('KeyW');
      await expect
        .poll(
          () =>
            host.evaluate(() => {
              const v = window.__WOBBLE_GAME__.player.velocity;
              return Math.hypot(v.x, v.z);
            }),
          { timeout: 5000, message: 'после подъёма управление работает' }
        )
        .toBeGreaterThan(speedWhileDown + 1);
      await host.keyboard.up('KeyW');

      // И соперник видит, что тот снова на ногах.
      await expect
        .poll(() => remoteState(guest, hostId), { timeout: 5000, message: 'соперник видит подъём' })
        .not.toBe('knockdown');
    } finally {
      await Promise.all([hostContext.close(), guestContext.close()]);
    }
  });
});
