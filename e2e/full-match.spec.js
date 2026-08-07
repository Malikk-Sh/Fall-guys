// Сквозной сценарий полного матча: от создания комнаты до реванша и возвращения после перезагрузки.
//
// Существующий браузерный тест доходил до старта забега и проверял переподключение. Всё, что дальше
// — честный финиш, экран результатов у обоих, голосование, настоящий перезапуск уровня — держалось
// только на серверных тестах. Между ними и живой игрой помещается весь клиент: разметка, состояния
// экранов, обработчики кнопок. Исторически самые дорогие ошибки жили именно там.
//
// Забег проходится по-настоящему: бот держит «вперёд» и прыгает, сервер проверяет каждое положение
// и телепорт не примет. Поэтому тест идёт настоящее время и на короткой трассе — иначе он проверял
// бы не игру, а обход её правил.
//
// Трасса задана сидом WOBBLE_FIXED_SEED (см. playwright.config.js): в гонке она случайная, а тест на
// случайной трассе означал бы разное каждый прогон. Тест, который падает через раз и не
// воспроизводится, хуже отсутствующего.

import { test, expect } from '@playwright/test';

// Запас на прохождение. Замер на этой машине — 19–21 секунда, но потолок взят кратно больше по двум
// причинам: падение возвращает на чекпоинт и сегмент приходится проходить заново, а на раннере CI
// WebGL рисуется программно, и вся игра идёт заметно медленнее. Физика при этом ограничена пятью
// подшагами на кадр, то есть при низком FPS забег растягивается во времени пропорционально.
const RUN_BUDGET_MS = 150_000;

async function createRoom(page, name) {
  await page.goto('/');
  // Сложность выбирается ДО переключения вкладки: выпадающий список живёт в панели одиночной игры,
  // а комнату гонки создают уже на соседней вкладке — при этом читается всё тот же список.
  // Лёгкая трасса выбрана намеренно: она самая короткая, а тест идёт настоящее время.
  await page.locator('#difficulty').selectOption('easy');
  await page.locator('[data-mode="multi"]').click();
  await page.locator('#name').fill(name);
  await page.locator('#create').click();
  await expect(page.locator('#lobby')).toBeVisible();
  return (await page.locator('#roomCode').textContent()).trim();
}

async function joinRoom(page, name, code) {
  await page.goto('/');
  await page.locator('[data-mode="multi"]').click();
  await page.locator('#name').fill(name);
  await page.locator('#code').fill(code);
  await page.locator('#join').click();
  await expect(page.locator('#lobby')).toBeVisible();
}

// Доводит игрока до финиша живым управлением: те же клавиши, что нажимает человек.
//
// Одного «вперёд» не хватает. Первая версия бота только держала W и застревала на «узком повороте»
// — держась прямо, поворот не пройти, — а финальный сегмент лёгкой трассы всегда ветреный, и на нём
// боком сдувает с платформы. Поэтому бот подруливает к середине трассы.
//
// Положение читается из window.__WOBBLE_GAME__, который клиент выставляет и без тестов. Никакого
// обхода правил тут нет: это собственная позиция игрока, которую его же браузер и рисует, а сервер
// всё равно проверяет каждое присланное состояние.
const CENTER_TOLERANCE = 0.8;

// Сколько строк сейчас в таблице подтверждённых рекордов этой трассы. Сид и сложность фиксированы
// конфигурацией, поэтому запрос детерминированный.
async function countRecords(page) {
  const response = await page.request.get('/leaderboard?seed=8&difficulty=easy&limit=25');
  expect(response.ok()).toBe(true);
  return (await response.json()).entries.length;
}

async function runToFinish(page, budget = RUN_BUDGET_MS) {
  const deadline = Date.now() + budget;
  const held = new Set();
  const hold = async key => {
    if (held.has(key)) return;
    await page.keyboard.down(key);
    held.add(key);
  };
  const release = async key => {
    if (!held.has(key)) return;
    await page.keyboard.up(key);
    held.delete(key);
  };

  await hold('KeyW');
  try {
    while (Date.now() < deadline) {
      const status = await page.evaluate(() => {
        const player = window.__WOBBLE_GAME__?.player;
        return {
          x: player?.position?.x ?? 0,
          finished: !!player?.finished,
          results: !document.querySelector('#finish')?.classList.contains('hidden')
        };
      });
      if (status.finished || status.results) return true;

      // Подруливание к оси трассы. Клавиши те же, что у человека: управление относительно камеры,
      // а камера идёт за спиной, поэтому «вправо» — это плюс по X.
      if (status.x > CENTER_TOLERANCE) {
        await release('KeyD');
        await hold('KeyA');
      } else if (status.x < -CENTER_TOLERANCE) {
        await release('KeyA');
        await hold('KeyD');
      } else {
        await release('KeyA');
        await release('KeyD');
      }

      // Прыжок отдельным нажатием, а не удержанием: удержание — это планирование, и с ним игрок
      // проносится мимо узких платформ вместо того, чтобы на них приземлиться.
      await page.keyboard.press('Space');
      await page.waitForTimeout(220);
    }
  } finally {
    for (const key of [...held]) await release(key);
  }
  return false;
}

test.describe('полный матч на двоих', () => {
  // Настоящий забег идёт настоящее время, и его нельзя ускорить: сервер проверяет скорость так же,
  // как у живого игрока.
  test.setTimeout(240_000);

  // Оба сценария идут только на десктопном проекте. Проверяется ход матча, а не управление с
  // телефона: тот же прогон на втором наборе устройств удвоил бы самый долгий тест набора, ничего
  // нового не проверив. Ввод с сенсора покрыт отдельным тестом входа в кооп-комнату.
  const desktopOnly = testInfo =>
    test.skip(testInfo.project.name !== 'chromium', 'долгий сценарий гоняется один раз, на десктопе');

  test('оба доходят до финиша, голосуют за реванш и возвращаются в новый матч', async ({
    browser
  }, testInfo) => {
    desktopOnly(testInfo);
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = testInfo.project.use;
    const device = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    const hostContext = await browser.newContext(device);
    const guestContext = await browser.newContext(device);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    const before = await countRecords(host);
    const code = await createRoom(host, 'Хост E2E');
    expect(code).toMatch(/^[A-Z0-9]{5}$/);
    await joinRoom(guest, 'Гость E2E', code);
    await expect(host.locator('#players .player-row')).toHaveCount(2);

    await host.locator('#ready').click();
    await guest.locator('#ready').click();
    await expect(host.locator('#players .ready')).toHaveCount(2);
    await host.locator('#start').click();
    await expect(host.locator('#hud')).toBeVisible({ timeout: 15_000 });
    await expect(guest.locator('#hud')).toBeVisible({ timeout: 15_000 });

    // Бегут одновременно — как в настоящей гонке, и вдвое быстрее последовательного прогона.
    const [hostDone, guestDone] = await Promise.all([runToFinish(host), runToFinish(guest)]);
    expect(hostDone, 'хост обязан дойти до финиша').toBe(true);
    expect(guestDone, 'гость обязан дойти до финиша').toBe(true);

    // Экран результатов у обоих, и оба видят обоих: таблица собирается на сервере и рассылается.
    await expect(host.locator('#finish')).toBeVisible();
    await expect(guest.locator('#finish')).toBeVisible();
    await expect(host.locator('#board')).toContainText('Гость E2E');
    await expect(guest.locator('#board')).toContainText('Хост E2E');

    // Забег пройден честно, поэтому отметки «без зачёта» быть не должно: она означала бы, что
    // проверка движения сочла обычный бег подозрительным.
    //
    // Ровно это и происходило. Единичный удар бампера давал всплеск ускорения, а его хватало, чтобы
    // снять зачёт со всего забега: честный результат до таблицы рекордов не доезжал никогда. Найдено
    // этим тестом — серверные проверки смотрели на отдельные пакеты и такого сказать не могли.
    await expect(host.locator('#unrankedNote')).toBeHidden();

    // И сам факт: оба результата попали в таблицу подтверждённых рекордов.
    //
    // Сравнение с замером ДО матча, а не просто «в таблице что-то есть»: таблица живёт в процессе
    // сервера и переживает соседние тесты, поэтому непустой она может быть и без нашего забега.
    const after = await countRecords(host);
    expect(after - before, 'оба честных результата обязаны попасть в таблицу').toBe(2);

    // Первый голос экран не закрывает — второй игрок ещё решает.
    await host.locator('#rematch').click();
    await expect(host.locator('#rematch')).toContainText('✓');
    await expect(guest.locator('#finish')).toBeVisible();

    // Второй голос запускает матч заново — тот же уровень, обоим.
    await guest.locator('#rematch').click();
    await expect(host.locator('#hud')).toBeVisible({ timeout: 20_000 });
    await expect(guest.locator('#hud')).toBeVisible({ timeout: 20_000 });

    // Перезагрузка посреди нового матча возвращает игрока в него же, а не в меню и не в прошлый матч.
    const token = await guest.evaluate(() => sessionStorage.getItem('wobble-session'));
    expect(token).toBeTruthy();
    await guest.reload();
    await expect(guest.locator('#hud')).toBeVisible({ timeout: 20_000 });
    await expect(guest.locator('#menu')).toBeHidden();
    expect(await guest.evaluate(() => sessionStorage.getItem('wobble-session'))).toBe(token);

    await hostContext.close();
    await guestContext.close();
  });

  // Разные решения и истечение срока проверены и на сервере, но там комната — это объект в памяти.
  // Здесь проверяется то, чего серверный тест увидеть не может: что игрок при этом действительно
  // возвращается в лобби и видит его, а не остаётся на карточке итогов с бесполезными кнопками.
  test('разные решения на результатах уводят обоих в лобби по истечении срока', async ({
    browser
  }, testInfo) => {
    desktopOnly(testInfo);
    const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = testInfo.project.use;
    const device = { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch };
    const hostContext = await browser.newContext(device);
    const guestContext = await browser.newContext(device);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    const code = await createRoom(host, 'Хост срок');
    await joinRoom(guest, 'Гость срок', code);
    await expect(host.locator('#players .player-row')).toHaveCount(2);
    await host.locator('#ready').click();
    await guest.locator('#ready').click();
    await host.locator('#start').click();
    await expect(host.locator('#hud')).toBeVisible({ timeout: 15_000 });

    const [hostDone, guestDone] = await Promise.all([runToFinish(host), runToFinish(guest)]);
    expect(hostDone && guestDone, 'оба обязаны дойти до финиша').toBe(true);

    // Обратный отсчёт до автоматического решения виден игроку: без него ожидание выглядит зависанием.
    await expect(host.locator('#resultsTimer')).not.toBeEmpty();

    // Решения расходятся: один хочет реванш, другой — в лобби. Согласия нет, поэтому реванша не
    // будет, и комната обязана уйти в лобби, а не остаться на результатах.
    await host.locator('#rematch').click();
    await guest.locator('#returnLobby').click();

    await expect(host.locator('#lobby')).toBeVisible({ timeout: 20_000 });
    await expect(guest.locator('#lobby')).toBeVisible({ timeout: 20_000 });
    await expect(host.locator('#finish')).toBeHidden();
    // Комната цела: оба на месте и могут начать заново.
    await expect(host.locator('#players .player-row')).toHaveCount(2);

    await hostContext.close();
    await guestContext.close();
  });
});
