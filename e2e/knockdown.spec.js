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

// Сколько держать «вперёд», проверяя потерю управления, и с каким шагом смотреть на скорость.
// Ряд обрывается сам, как только игрок встал: сбивание длится 1.05–1.65 с, а до этого места тест
// успевает потратить непредсказуемое время на опросы состояния, и фиксированное окно уехало бы за
// подъём. Под управлением даже пары кадров хватает, чтобы разгон стал видно.
const HELD_SAMPLES = 8;
const HELD_SAMPLE_MS = 80;
// Запас на дрожь физики и на остаточную инерцию удара. Замер на самой физике: сбитый из состояния
// покоя, удерживая «вперёд» эти полсекунды, при полной утечке управления набирает 7.70, при
// четвертной — 1.77, а при исправном коде — ровно 0.00.
//
// Проверено внедрением поломки: с knockdownControl, поднятым до 1, этот тест падает с «разогнался
// с 0.00 до 7.66». Отдельно взятая правка одного из двух гейтов (масштаб ввода и масштаб ускорения)
// им НЕ ловится — второй продолжает гасить разгон. Тест стережёт свойство «потеря управления
// действует», а не каждую строку по отдельности, и это ровно то, что он и обещает названием.
const CONTROL_LEAK_TOLERANCE = 1.5;
// А вот при какой начальной скорости проверка перестаёт что-либо значить: разогнанному почти до
// беговой (7.7) утечка добавит лишь десятые доли, и порог выше её не отличит. Поэтому базовая
// скорость проверяется отдельно — пусть тест скажет, что бессилен, а не промолчит.
const CONTROL_CHECK_BASELINE_MAX = 2;

// Скорость И остаток сбивания одним обменом со страницей: замер обязан относиться к тому же
// мгновению, что и признак «ещё лежит», иначе окно наблюдения незаметно уедет за подъём.
const sampleOf = page =>
  page.evaluate(() => {
    const player = window.__WOBBLE_GAME__.player;
    return { speed: Math.hypot(player.velocity.x, player.velocity.z), down: player.knockdownTimer > 0 };
  });

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

      // Дальше два наблюдения за ОДНИМ И ТЕМ ЖЕ окном, поэтому они идут параллельно.
      //
      // Окно короткое — сбивание длится 1.05–1.65 с, — и последовательные опросы состояния съели бы
      // его заметную часть: в первой редакции замер скорости уезжал за подъём и обвинял исправный
      // код в утечке управления, показывая ровно беговые 7.70.
      //
      // Что проверяет каждое. Слева — что состояние пересекло сетевую границу и его видит ВТОРОЙ
      // клиент; ради этого сценарий и браузерный. Справа — что сбитый действительно потерял
      // управление: «вперёд» держится несколько кадров подряд, и под управлением скорость за это
      // время ушла бы к беговой (ускорение по земле — 18 в секунду), а у сбитого остаётся лишь
      // затухающая инерция удара. Одного замера сразу после нажатия для этого мало: клавиша к тому
      // моменту ещё не дошла до шага физики, и «скорость не выросла» было бы правдой и при
      // полностью сломанной блокировке.
      const speeds = [];
      await Promise.all([
        expect
          .poll(() => remoteState(guest, hostId), { timeout: 5000, message: 'соперник видит сбитого' })
          .toBe('knockdown'),
        (async () => {
          await host.keyboard.down('KeyW');
          for (let sample = 0; sample < HELD_SAMPLES; sample++) {
            const now = await sampleOf(host);
            // За подъём выходить нельзя: там разгон законен, и замер оттуда обвинил бы исправный код.
            if (!now.down) break;
            speeds.push(now.speed);
            await host.waitForTimeout(HELD_SAMPLE_MS);
          }
        })()
      ]);
      await host.keyboard.up('KeyW');
      expect(speeds.length, 'нужен хотя бы один замер, снятый пока игрок ещё лежит').toBeGreaterThan(1);

      const speedWhileDown = Math.max(...speeds);
      expect(
        speeds[0],
        `сбитый уже двигался со скоростью ${speeds[0].toFixed(2)} — на таком разгоне утечка управления неотличима`
      ).toBeLessThan(CONTROL_CHECK_BASELINE_MAX);
      expect(
        speedWhileDown,
        `сбитый разогнался с ${speeds[0].toFixed(2)} до ${speedWhileDown.toFixed(2)} — управление не отключено`
      ).toBeLessThan(speeds[0] + CONTROL_LEAK_TOLERANCE);

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
        .poll(async () => (await sampleOf(host)).speed, {
          timeout: 5000,
          message: 'после подъёма управление работает'
        })
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
