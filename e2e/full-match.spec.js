// Сквозной сценарий полного матча: от создания комнаты до реванша и возвращения после перезагрузки.
//
// Существующий браузерный тест доходил до старта забега и проверял переподключение. Всё, что дальше
// — честный финиш, экран результатов у обоих, голосование, настоящий перезапуск уровня — держалось
// только на серверных тестах. Между ними и живой игрой помещается весь клиент: разметка, состояния
// экранов, обработчики кнопок. Исторически самые дорогие ошибки жили именно там.
//
// Забег проходится по-настоящему: водитель держит «вперёд» и прыгает, сервер проверяет каждое
// положение и телепорт не примет. Поэтому тест идёт настоящее время — иначе он проверял бы не игру,
// а обход её правил.
//
// Трасса задана снаружи (WOBBLE_FIXED_SEED и WOBBLE_E2E_SEGMENTS, см. playwright.config.js): в
// гонке она случайная, а тест на случайной трассе означал бы разное каждый прогон. Тест, который
// падает через раз и не воспроизводится, хуже отсутствующего. Её сид подобран замером под этого
// водителя, а длина укорочена до трёх сегментов — два настоящих Chromium на одной машине выдают
// 10–15 кадров в секунду, и полная трасса перестаёт укладываться в бюджет из-за раннера, а не
// из-за игры. Почему это допустимо и чем ограничено — в server/e2eCourse.js.
//
// ЧТО ЗДЕСЬ НЕ ПРОВЕРЯЕТСЯ, и это осознанно. Водитель намеренно простой: он не разбирает
// препятствия, не выбирает момент прыжка и не обходит ловушки. Проходимость всех настоящих трасс
// проверяют боты и физика (server/raceBot.test.mjs, server/traverse.test.mjs) — без браузера, без
// кадров и на десятках сидов. Сбивание с ног проверяет e2e/knockdown.spec.js, где два клиента и
// один удар. Здесь же проверяется ровно то, чего не увидеть ни оттуда, ни со стороны сервера:
// сквозной жизненный цикл матча в двух настоящих браузерах.
//
// Поэтому падение этого теста означает поломку матча, а не «водитель не справился с трассой» — при
// условии, что сам водитель не превращает задержку CI в многосекундно зажатую боковую клавишу.

import { test, expect } from '@playwright/test';

// Запас на прохождение. Трасса короткая, но потолок взят кратно больше: падение возвращает на
// чекпоинт и сегмент приходится проходить заново, а физика ограничена пятью подшагами на кадр, то
// есть при низком FPS раннера забег растягивается по настенным часам пропорционально.
const RUN_BUDGET_MS = 150_000;

// Имя игрока живёт в аккаунте, а не отдельным полем в меню. Задаём его так же, как игрок: открываем
// окно аккаунта, вводим имя, сохраняем.
async function setPlayerName(page, name) {
  // Игрок приходит гостем — аккаунт больше не заводится сам. Заводим его явно, как это делает
  // человек: открываем окно аккаунта и нажимаем кнопку входа. Без этого переименовывать нечего.
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

async function createRoom(page, name) {
  await page.goto('/');
  await setPlayerName(page, name);
  // Сложность выбирается ДО переключения вкладки: выпадающий список живёт в панели одиночной игры,
  // а комнату гонки создают уже на соседней вкладке — при этом читается всё тот же список.
  // Лёгкая трасса выбрана намеренно: она самая короткая, а тест идёт настоящее время.
  await page.locator('#difficulty').selectOption('easy');
  await page.locator('[data-mode="multi"]').click();
  await page.locator('#create').click();
  await expect(page.locator('#lobby')).toBeVisible();
  return (await page.locator('#roomCode').textContent()).trim();
}

async function joinRoom(page, name, code) {
  await page.goto('/');
  await setPlayerName(page, name);
  await page.locator('[data-mode="multi"]').click();
  await page.locator('#code').fill(code);
  await page.locator('#join').click();
  await expect(page.locator('#lobby')).toBeVisible();
}

// Доводит игрока до финиша живым управлением: те же клавиши, что нажимает человек.
//
// Водитель специально примитивный, и это его главное свойство. Всё, что он умеет, — держать
// «вперёд», коротко подруливать к оси трассы и жать прыжок. Разбор препятствий, выбор момента,
// реакция на конкретный тип опасности сюда не добавляются сознательно: умный водитель становится
// второй игровой логикой, которую придётся чинить при каждой правке баланса, и падение теста
// перестаёт что-либо означать. Трасса подобрана под ЭТОГО водителя, а не наоборот.
//
// Положение читается из window.__WOBBLE_GAME__, который клиент выставляет и без тестов. Никакого
// обхода правил тут нет: это собственная позиция игрока, которую его же браузер и рисует, а сервер
// всё равно проверяет каждое присланное состояние.
const CENTER_TOLERANCE = 0.8;

// Боковая коррекция — импульс ограниченной длительности, а не клавиша, зажатая до следующего
// round-trip Playwright. Это различие оказалось критичным именно на CI.
//
// В trace красного прогона фактический промежуток между чтениями позиции был не 220 мс из
// waitForTimeout, а примерно 0.9 с по медиане и доходил до ~1.7 с. Из-за прежнего hold/release A/D
// боковая клавиша оставалась зажатой ещё дольше: около двух секунд по медиане и до ~7 секунд.
// После удара бампера/knockdown это превращало устаревшую коррекцию в новый разгон поперёк трассы;
// в том же trace x гулял примерно от -15 до +15. Это уже поведение тестового водителя, а не матча.
//
// 140 мс хватает хотя бы на один кадр даже около 10 FPS, но длительность не зависит от того,
// насколько занят runner после этого. Клавиша по-прежнему настоящая — проходит через тот же Input,
// что и у человека.
const STEER_PULSE_MS = 140;

async function steerTowardCenter(page, x) {
  if (x > CENTER_TOLERANCE) await page.keyboard.press('KeyA', { delay: STEER_PULSE_MS });
  else if (x < -CENTER_TOLERANCE) await page.keyboard.press('KeyD', { delay: STEER_PULSE_MS });
}

// Сколько строк сейчас в таблице подтверждённых рекордов этой трассы. Сид и сложность фиксированы
// конфигурацией, поэтому запрос детерминированный.
async function countRecords(page) {
  const response = await page.request.get('/leaderboard?seed=130&difficulty=easy&limit=25');
  expect(response.ok()).toBe(true);
  return (await response.json()).entries.length;
}

// Что видно снаружи о ходе забега. Нужно не для управления, а для сообщения об ошибке: «обязан
// дойти до финиша» без единой цифры не даёт понять, встал ли водитель на препятствии, не начал ли
// забег вовсе или просто не уложился в бюджет на медленной машине.
const progress = page =>
  page.evaluate(() => {
    const game = window.__WOBBLE_GAME__;
    const player = game?.player;
    return {
      x: player?.position?.x ?? null,
      z: player?.position?.z ?? null,
      checkpoint: player?.checkpoint ?? null,
      finishZ: game?.course?.spec?.finishZ ?? null,
      segments: game?.course?.spec?.segmentCount ?? null,
      state: player?.snapshot?.().state ?? null,
      respawns: player?.respawns ?? null,
      finished: !!player?.finished,
      hud: !document.querySelector('#hud')?.classList.contains('hidden'),
      results: !document.querySelector('#finish')?.classList.contains('hidden')
    };
  });

const describeRun = report =>
  report.done
    ? 'дошёл'
    : `не дошёл за ${(report.seconds ?? 0).toFixed(0)} с: z=${report.z ?? '—'} из ${report.finishZ ?? '—'}, ` +
      `чекпоинт ${report.checkpoint ?? '—'}/${report.segments ?? '—'}, состояние ${report.state ?? '—'}, ` +
      `падений ${report.respawns ?? '—'}, HUD ${report.hud ? 'виден' : 'нет'}`;

async function runToFinish(page, budget = RUN_BUDGET_MS) {
  const startedAt = Date.now();
  const deadline = startedAt + budget;
  await page.keyboard.down('KeyW');
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
      if (status.finished || status.results) return { done: true, seconds: (Date.now() - startedAt) / 1000 };

      await steerTowardCenter(page, status.x);

      // Прыжок отдельным нажатием, а не удержанием: удержание — это планирование, и с ним игрок
      // проносится мимо узких платформ вместо того, чтобы на них приземлиться.
      await page.keyboard.press('Space');
      await page.waitForTimeout(220);
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
  return { done: false, seconds: (Date.now() - startedAt) / 1000, ...(await progress(page)) };
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
    const [hostRun, guestRun] = await Promise.all([runToFinish(host), runToFinish(guest)]);
    expect(hostRun.done, `хост ${describeRun(hostRun)}`).toBe(true);
    expect(guestRun.done, `гость ${describeRun(guestRun)}`).toBe(true);

    // Экран результатов у обоих, и оба видят обоих: таблица собирается на сервере и рассылается.
    //
    // Тот, кто дошёл первым, попадает сюда не сразу: своим финишем гонка для него не кончается, он
    // остаётся досматривать её. Значит, эта же проверка стережёт и обратный путь — карточка обязана
    // подняться сама, когда матч завершится. Раньше она появлялась по собственному финишу, и
    // сломать переход было нечем.
    await expect(host.locator('#finish')).toBeVisible({ timeout: 15_000 });
    await expect(guest.locator('#finish')).toBeVisible({ timeout: 15_000 });
    await expect(host.locator('#board')).toContainText('Гость E2E');
    await expect(guest.locator('#board')).toContainText('Хост E2E');
    // Баннер досмотра не должен пережить карточку итогов.
    await expect(host.locator('#spectate')).toBeHidden();
    await expect(guest.locator('#spectate')).toBeHidden();

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

    // Выход из идущего матча. Кнопки не было вовсе: из забега выходили только через финиш, а в
    // кооперативе, где напарник может уйти посреди главы, оставшийся запирался навсегда —
    // перезагрузка страницы возвращает в тот же матч.
    //
    // Подтверждение вторым нажатием проверяется отдельно: первое нажатие обязано только
    // предупредить, иначе случайное касание на телефоне стоило бы забега.
    await host.locator('#leaveMatch').click();
    await expect(host.locator('#leaveMatch')).toHaveText('ТОЧНО?');
    await expect(host.locator('#hud')).toBeVisible();
    await host.locator('#leaveMatch').click();
    await expect(host.locator('#menu')).toBeVisible({ timeout: 10_000 });
    await expect(host.locator('#hud')).toBeHidden();

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
    // Готовность обоих и появление HUD у ОБОИХ — то же, что и в сценарии выше. Раньше здесь
    // ждали только хоста, и отсчёт бюджета гостя начинался, пока тот ещё собирал уровень: на
    // медленной машине эта фора уходила в минус целиком.
    await expect(host.locator('#players .ready')).toHaveCount(2);
    await host.locator('#start').click();
    await expect(host.locator('#hud')).toBeVisible({ timeout: 20_000 });
    await expect(guest.locator('#hud')).toBeVisible({ timeout: 20_000 });

    const [hostRun, guestRun] = await Promise.all([runToFinish(host), runToFinish(guest)]);
    expect(hostRun.done, `хост ${describeRun(hostRun)}`).toBe(true);
    expect(guestRun.done, `гость ${describeRun(guestRun)}`).toBe(true);

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
