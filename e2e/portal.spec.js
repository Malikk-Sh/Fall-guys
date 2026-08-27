import { expect, test } from '@playwright/test';

// Портальный билд, открытый так, как его откроет игрок на площадке: с подпути чужого домена.
//
// ЗАЧЕМ ЭТОТ НАБОР СУЩЕСТВУЕТ. Портальную сборку я до сих пор проверял перечислением — выписывал
// места, где клиент ходит в сеть, и закрывал каждое. Список оказывался неполным четыре раза подряд:
// кнопки аккаунта, кооп-рейтинг, отправка соло-рекорда, вход по recovery-коду. Каждый раз проверка
// была верной, а вопрос — узким: я смотрел туда, где удобно смотреть, а не туда, где живёт результат.
//
// Здесь вопрос задан один и по существу: открыть собранный билд в браузере и посмотреть, что он
// делает. Ни один новый сетевой вызов, откуда бы он ни взялся, мимо такой проверки не пройдёт — её
// не надо дополнять списком.

const OUR_SERVER = /\/api\/|\/ws\b|\/leaderboard/;

async function openPortal(page) {
  const requests = [];
  const consoleErrors = [];
  const failures = [];

  page.on('request', request => requests.push(request.url()));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('response', response => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });

  await page.goto('/game/', { waitUntil: 'networkidle' });
  // Меню поднимает `pwa-entry.js` уже после модулей игры; без паузы часть его установщиков ещё не
  // отработала, и проверка целости интерфейса мерила бы недогруженную страницу.
  await page.waitForTimeout(2000);

  return { requests, consoleErrors, failures };
}

// ГЛАВНАЯ ПРОВЕРКА НАБОРА.
//
// Наш сервер портальной сборке недоступен по построению: он однодоменный. Любое обращение к нему
// оттуда — это запрос на чужой домен, который в лучшем случае даст 404 в консоли, а в худшем уведёт
// игрока в вечное «соединение потеряно».
test('портальный билд не обращается к нашему серверу', async ({ page }) => {
  const { requests } = await openPortal(page);

  const ours = requests.filter(url => OUR_SERVER.test(url));
  expect(ours, `портальный билд не должен ходить на наш сервер:\n${ours.join('\n')}`).toEqual([]);
  // Запросы вообще идти обязаны: пустой список означал бы, что страница не загрузилась и проверка
  // выше прошла впустую.
  expect(requests.length).toBeGreaterThan(20);
});

test('портальный билд загружается без ошибок и промахов пути', async ({ page }) => {
  const { consoleErrors, failures } = await openPortal(page);

  // 404 здесь означает уцелевший абсолютный путь — ровно та поломка, ради которой билд и раздаётся
  // с подпути.
  expect(failures, `неудачные запросы:\n${failures.join('\n')}`).toEqual([]);
  expect(consoleErrors, `ошибки консоли:\n${consoleErrors.join('\n')}`).toEqual([]);
});

// Интерфейс обязан уехать ЦЕЛИКОМ.
//
// Однажды я исключил из билда `pwa-entry.js` «как PWA-обвязку» — по имени. На деле он поднимает весь
// интерфейс, и портальная сборка осталась с голым канвасом, загружаясь при этом без единой ошибки.
// Ни один тест путей этого не увидел, и проверка «игра грузится» тоже: канвас-то был.
test('интерфейс портального билда поднят целиком', async ({ page }) => {
  await openPortal(page);

  const state = await page.evaluate(() => ({
    canvas: !!document.querySelector('canvas'),
    mobile: !!globalThis.__WOBBLE_MOBILE_EXPERIENCE__,
    results: !!globalThis.__WOBBLE_RESULTS_PRESENTATION__,
    tutorial: !!globalThis.__WOBBLE_TOUCH_TUTORIAL__,
    rewards: !!globalThis.__WOBBLE_REWARD_REVEAL__,
    // PWA — единственное, чего на площадке быть не должно: service worker в билд не уезжает.
    pwa: !!globalThis.__WOBBLE_PWA__
  }));

  expect(state.canvas).toBe(true);
  expect(state.mobile, 'мобильный опыт обязан подняться: аудитория площадки мобильная').toBe(true);
  expect(state.results).toBe(true);
  expect(state.tutorial).toBe(true);
  expect(state.rewards).toBe(true);
  expect(state.pwa, 'PWA на площадке не запускается: service worker в билд не уезжает').toBe(false);
});

// Одиночная игра доступна, сетевая — нет, и ровно в этом весь смысл портальной сборки.
test('на площадке доступно одиночное и скрыто сетевое', async ({ page }) => {
  await openPortal(page);

  const shown = selector =>
    page.evaluate(css => {
      const node = document.querySelector(css);
      if (!node) return null;
      return !node.hidden && !node.closest('[hidden]');
    }, selector);

  expect(await shown('.mode-tab[data-mode="single"]'), 'одиночная игра обязана остаться').toBe(true);
  expect(await shown('.mode-tab[data-mode="multi"]')).toBe(false);
  expect(await shown('.mode-tab[data-mode="coop"]')).toBe(false);

  // Шкаф — локальная косметика, к серверу отношения не имеет. Однажды я закрыл к нему доступ,
  // спрятав чип аккаунта: единственный ход к шкафу лежит через открываемый им экран.
  expect(await shown('#accountChip'), 'через чип единственный ход к шкафу').toBe(true);
  expect(await shown('#openWardrobe'), 'шкаф локальный и обязан остаться').toBe(true);

  // А сетевое внутри того же экрана скрыто.
  expect(await shown('#accountSignIn')).toBe(false);
  expect(await shown('#accountEnter')).toBe(false);
  expect(await shown('#profileOpen')).toBe(false);
});

// Пропущенный вход не должен оставлять интерфейс в заготовке.
test('гостевое состояние применено, а не оставлено шаблоном', async ({ page }) => {
  await openPortal(page);

  const chip = page.locator('#accountChip');
  await expect(chip).toContainText('ГОСТЬ');
  // Многоточие — это шаблон разметки: значит `setAccount()` не вызывался вовсе.
  await expect(page.locator('#accountName')).not.toHaveText('…');
  await expect(chip).toHaveClass(/account-chip-guest/);
});
