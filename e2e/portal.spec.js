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

// Дозволенное задано ОТ ОБРАТНОГО, и это принципиально.
//
// Сначала здесь стоял список путей нашего сервера — `/api/`, `/ws`, `/leaderboard`. Он был неполон
// уже в момент написания: аккаунт создаётся запросом на `/account` (client/core/account.js), мимо
// всех трёх признаков. Набор, написанный ради отказа от перечисления, внутри себя перечислял — и
// ошибся ровно так же.
//
// Замена признака на «чужой домен» тоже неверна, и это стоило отдельного прогона: наш клиент
// однодоменный и ходит на сервер КОРНЕВЫМИ путями (`fetch('/api/auth/session')`). С подпути они
// разрешаются в тот же origin, что и раздача, — то есть проверка по домену их не видит вовсе.
//
// Верный признак — точка монтирования. Портальный билд целиком лежит под ней, а всё, что наш сервер
// когда-либо отдавал, висит в КОРНЕ чужого домена. Поэтому дозволено ровно одно: то, что лежит под
// подпутём, плюс схемы, которые никуда не идут. Список поддерживать не нужно ни с какой стороны:
// новый серверный путь, о котором мы не знали, попадает сюда сам.
const ALLOWED_SCHEMES = /^(data|blob|about|chrome-extension):/;
// Совпадает с MOUNT в scripts/servePortalBuild.mjs — там же и объяснение, почему корень закрыт.
const MOUNT = '/game/';

function outsideBuild(requests, baseURL) {
  const origin = new URL(baseURL).origin;
  return requests.filter(url => {
    if (ALLOWED_SCHEMES.test(url)) return false;
    if (!url.startsWith(origin)) return true;
    return !new URL(url).pathname.startsWith(MOUNT);
  });
}

// Слежка ставится до первого перехода и НЕ снимается: набор смотрит не на загрузку страницы, а на
// путь игрока целиком. Запрос, уходящий по действию в меню или на финише забега, обязан попадать в
// тот же список, что и запросы загрузки.
function watch(page) {
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

  return { requests, consoleErrors, failures };
}

async function openPortal(page) {
  const seen = watch(page);

  await page.goto('/game/', { waitUntil: 'networkidle' });
  // Меню поднимает `pwa-entry.js` уже после модулей игры; ждём готовности по видимому признаку, а
  // не по таймеру: на мобильном раннере пауза фиксированной длины означала бы разное.
  await expect(page.locator('#menu')).toBeVisible({ timeout: 30_000 });

  return seen;
}

// ИНВАРИАНТ СТЕНДА. Всё, ради чего этот набор существует, держится на том, что корень раздачи
// закрыт: уцелевший абсолютный путь `/vendor/three.js` ломается только там, где по корню никто не
// отвечает. Начни раздача когда-нибудь отдавать билд ещё и с корня — набор остался бы зелёным,
// перестав при этом моделировать площадку. Проверяем стенд раньше, чем ему верим.
test('корень раздачи закрыт: стенд действительно моделирует подпуть', async ({ page, baseURL }) => {
  const response = await page.request.get(`${baseURL}/`);
  expect(response.status(), 'корень обязан отвечать 404, иначе абсолютные пути не ломаются').toBe(404);
});

// ГЛАВНАЯ ПРОВЕРКА НАБОРА.
//
// Наш сервер портальной сборке недоступен по построению: он однодоменный. Любое обращение к нему
// оттуда — это запрос на чужой домен, который в лучшем случае даст 404 в консоли, а в худшем уведёт
// игрока в вечное «соединение потеряно».
//
// Замер идёт не по загрузке, а по пути игрока: меню → окно аккаунта → шкаф → забег → финиш →
// возврат. Отправка соло-рекорда, например, живёт именно на финише, и загрузкой страницы её не
// увидеть вовсе.
test('портальный билд не выходит за пределы своей сборки на всём пути игрока', async ({ page, baseURL }) => {
  const { requests } = await openPortal(page);

  const afterLoad = requests.length;
  // Запросы загрузки идти обязаны: пустой список означал бы, что страница не открылась и проверка
  // ниже прошла бы впустую.
  expect(afterLoad).toBeGreaterThan(20);

  // Окно аккаунта и шкаф — самые богатые на сетевые вызовы экраны.
  await page.locator('#accountChip').click();
  await expect(page.locator('#account')).toBeVisible();
  await page.locator('#openWardrobe').click();
  await expect(page.locator('#wardrobe')).toBeVisible({ timeout: 15_000 });
  await page.locator('#wardrobeClose').click();
  await expect(page.locator('#wardrobe')).toBeHidden();
  await page.locator('#accountClose').click();
  await expect(page.locator('#account')).toBeHidden();

  // Забег и финиш. Финиш вызывается напрямую — тем же способом, что и в десктопном наборе: пройти
  // трассу живым управлением здесь не нужно, нужен код, который выполняется по её завершении.
  await page.locator('#play').click();
  await expect(page.locator('#hud')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const game = globalThis.__WOBBLE_GAME__;
    game.ui.finishSolo({ time: 45_000, respawns: 0, dashes: 1, hits: 0, spec: game.course.spec });
  });
  await expect(page.locator('#finish')).toBeVisible({ timeout: 15_000 });
  // Время после финиша: отправка рекорда ушла бы уже после отрисовки экрана.
  await page.waitForTimeout(1500);

  // Что путь пройден, доказано выше видимым состоянием: шкаф открылся, забег пошёл, экран финиша
  // показан. Числом запросов это не доказывается и доказываться не должно — после загрузки
  // правильный портальный билд не запрашивает НИЧЕГО, и замер это подтверждает: и на настольном, и
  // на мобильном проекте список к концу пути тот же, что сразу после загрузки.
  //
  // Здесь стояло `toBeGreaterThan(afterLoad)` — «путь обязан породить запросы». Утверждение было
  // ложным по существу, а не строгим: сбудься оно, это означало бы, что билд куда-то ходит.
  expect(requests.length).toBeGreaterThanOrEqual(afterLoad);

  const outside = outsideBuild(requests, baseURL);
  expect(outside, `портальный билд не должен ходить за пределы билда:\n${outside.join('\n')}`).toEqual([]);
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
    mobile: !!globalThis.__WOBBLE_MOBILE_EXPERIENCE__,
    results: !!globalThis.__WOBBLE_RESULTS_PRESENTATION__,
    tutorial: !!globalThis.__WOBBLE_TOUCH_TUTORIAL__,
    rewards: !!globalThis.__WOBBLE_REWARD_REVEAL__,
    // PWA — единственное, чего на площадке быть не должно: service worker в билд не уезжает.
    pwa: !!globalThis.__WOBBLE_PWA__
  }));

  // Глобали говорят лишь о том, что установщик отработал. Видимость меню и сцены меряется
  // браузером — установщик мог отработать и над невидимым деревом.
  await expect(page.locator('#game')).toBeVisible();
  await expect(page.locator('#menu')).toBeVisible();

  expect(state.mobile, 'мобильный опыт обязан подняться: аудитория площадки мобильная').toBe(true);
  expect(state.results).toBe(true);
  expect(state.tutorial).toBe(true);
  expect(state.rewards).toBe(true);
  expect(state.pwa, 'PWA на площадке не запускается: service worker в билд не уезжает').toBe(false);
});

// Одиночная игра доступна, сетевая — нет, и ровно в этом весь смысл портальной сборки.
//
// Видимость проверяется браузером, а не предикатом по атрибуту `hidden`. Предикат здесь уже
// обманул меня однажды: экран аккаунта скрыт КЛАССОМ `.hidden`, а не атрибутом, поэтому кнопка
// шкафа внутри закрытого экрана считалась видимой, и утверждение «шкаф на месте» держалось само
// по себе — оно было бы верным и с наглухо недостижимым шкафом.
test('на площадке доступно одиночное и скрыто сетевое', async ({ page }) => {
  await openPortal(page);

  await expect(
    page.locator('.mode-tab[data-mode="single"]'),
    'одиночная игра обязана остаться'
  ).toBeVisible();
  await expect(page.locator('.mode-tab[data-mode="multi"]')).toBeHidden();
  await expect(page.locator('.mode-tab[data-mode="coop"]')).toBeHidden();

  // Шкаф — локальная косметика, к серверу отношения не имеет. Однажды я закрыл к нему доступ,
  // спрятав чип аккаунта: единственный ход к шкафу лежит через открываемый им экран. Поэтому ход
  // проходится целиком, а не утверждается по наличию узла.
  await expect(page.locator('#accountChip')).toBeVisible();
  await page.locator('#accountChip').click();
  await expect(page.locator('#account')).toBeVisible();
  await expect(page.locator('#openWardrobe'), 'шкаф обязан быть достижим через чип').toBeVisible();

  // А сетевое внутри того же открытого экрана скрыто.
  await expect(page.locator('#accountSignIn')).toBeHidden();
  await expect(page.locator('#accountEnter')).toBeHidden();
  await expect(page.locator('#profileOpen')).toBeHidden();

  // Шкаф не просто виден, а открывается: кнопка могла бы вести в экран, которого в билде нет.
  await page.locator('#openWardrobe').click();
  await expect(page.locator('#wardrobe')).toBeVisible({ timeout: 15_000 });
});

// ТО, ЧТО ОБЕЩАНО В ПОЛИТИКЕ, ДОЛЖНО ЧЕМ-ТО ДЕРЖАТЬСЯ.
//
// Портальная политика утверждает три вещи про хранение: данные лежат в браузере, cookies Wobble
// Rush не используются, аккаунт не создаётся. Это юридический документ, и подпирать его чтением
// кода мало — здесь он подпирается замером.
//
// Считаются ОБРАЩЕНИЯ, а не итоговое содержимое: запись, которую потом стёрли, всё равно была.
test('на площадке игра пишет только в localStorage и не ставит cookies', async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.__written = [];
    globalThis.__session = [];
    globalThis.__idb = 0;
    const local = globalThis.localStorage;
    const localSet = local.setItem.bind(local);
    local.setItem = (key, value) => {
      globalThis.__written.push(key);
      return localSet(key, value);
    };
    for (const method of ['setItem', 'getItem', 'removeItem']) {
      const session = globalThis.sessionStorage;
      const original = session[method].bind(session);
      session[method] = (...args) => {
        globalThis.__session.push(`${method}:${args[0]}`);
        return original(...args);
      };
    }
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      globalThis.__idb += 1;
      return open(...args);
    };
  });

  await page.goto('/game/', { waitUntil: 'networkidle' });
  await expect(page.locator('#menu')).toBeVisible({ timeout: 30_000 });

  // Забег с финишем: именно там пишутся рекорд и профиль, то есть всё, что игра вообще сохраняет.
  await page.locator('#play').click();
  await expect(page.locator('#hud')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const game = globalThis.__WOBBLE_GAME__;
    game.ui.finishSolo({ time: 45_000, respawns: 0, dashes: 1, hits: 0, spec: game.course.spec });
  });
  await expect(page.locator('#finish')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1000);

  const state = await page.evaluate(() => ({
    written: [...new Set(globalThis.__written)].sort(),
    session: globalThis.__session,
    idb: globalThis.__idb,
    cookie: document.cookie
  }));

  // Всё сохранённое — наше и локальное.
  expect(state.written.length).toBeGreaterThan(0);
  const foreign = state.written.filter(key => !key.startsWith('wobble-'));
  expect(foreign, `в localStorage пишет кто-то посторонний: ${foreign.join(', ')}`).toEqual([]);

  // Сетевые пути на площадке закрыты, а `sessionStorage` в игре трогают только они: токен сессии
  // (`NetworkManager`) и приглашение (`main.js`). Обращение к нему означало бы, что заслон дал течь.
  expect(state.session, `sessionStorage трогают только сетевые пути: ${state.session.join(', ')}`).toEqual(
    []
  );
  expect(state.idb, 'IndexedDB игра не использует').toBe(0);
  expect(state.cookie, 'политика обещает отсутствие cookies Wobble Rush').toBe('');
});

// Политику конфиденциальности набор до сих пор НЕ ОТКРЫВАЛ — проверял только, что файл в билде
// есть и ссылка на него относительная. Этого мало по той же причине, по которой существует весь
// набор: страница могла бы открываться с промахами путей или оказаться политикой нашего сайта,
// заявляющей игроку обработку, которой на площадке не происходит.
test('политика конфиденциальности открывается и говорит про площадку', async ({ page, baseURL }) => {
  await page.goto('/game/', { waitUntil: 'networkidle' });
  await expect(page.locator('#menu')).toBeVisible({ timeout: 30_000 });

  // Ход тот же, что у игрока: из меню по ссылке, а не по прямому адресу. Ссылка помечена
  // `target="_blank"`, поэтому страница открывается СОСЕДНЕЙ вкладкой — и следить за ней надо
  // отдельно: `page.on('request')` чужую вкладку не видит, и проверка «не ходит наружу» молча
  // мерила бы пустой список.
  const link = page.locator('a[href$="privacy/"]').first();
  await expect(link).toHaveCount(1);
  const [policy] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  const seen = watch(policy);
  await policy.waitForLoadState('networkidle');

  await expect(policy.locator('h1').first()).toContainText('Политика конфиденциальности');
  // Главное утверждение страницы — оно же то, что набор проверяет замером выше.
  await expect(policy.locator('body')).toContainText('целиком в вашем браузере');
  // А про то, чего на площадке нет, страница молчать обязана.
  await expect(policy.locator('body')).not.toContainText('Google Identity Services');

  // Возврат в игру работает: ссылка переписана по глубине страницы, а не ведёт в корень домена.
  await policy.locator('a.back').click();
  await expect(policy.locator('#menu')).toBeVisible({ timeout: 30_000 });

  expect(seen.failures, `неудачные запросы:\n${seen.failures.join('\n')}`).toEqual([]);
  const outside = outsideBuild(seen.requests, baseURL);
  expect(outside, `страница политики ходит за пределы билда:\n${outside.join('\n')}`).toEqual([]);
  // Слежка обязана была что-то увидеть: пустой список означал бы, что мерили не ту вкладку.
  expect(seen.requests.length).toBeGreaterThan(0);
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
