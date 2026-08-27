import { defineConfig, devices } from '@playwright/test';

// Путь к браузеру можно задать снаружи. В готовых окружениях Chromium уже установлен, и его сборка
// не обязана совпадать с той, которую скачал бы сам Playwright под версию пакета. В CI переменная не
// задаётся — там браузер ставится шагом `playwright install`.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const launchOptions = executablePath ? { executablePath } : {};
const fullscreenSuite = /mobile-fullscreen\.spec\.js/;
const mobileOnlySuite = /mobile-(?:landscape|fullscreen)\.spec\.js/;
const fullMatchSuite = /full-match\.spec\.js/;
// Портальный набор живёт в СВОЕЙ конфигурации (playwright.portal.config.js): он смотрит на
// статический билд, а не на наш сервер. Здесь он только исключается — иначе проекты, идущие по
// каталогу `e2e/`, подобрали бы его и погнали против нашего сервера, где он бессмыслен.
const portalSuite = /portal\.spec\.js/;
const desktopIgnore =
  process.env.WOBBLE_E2E_EXCLUDE_FULL_MATCH === '1'
    ? [mobileOnlySuite, fullMatchSuite, portalSuite]
    : [mobileOnlySuite, portalSuite];
const requestedRetries = Number.parseInt(process.env.WOBBLE_E2E_RETRIES || '0', 10);
const ciRetries = Number.isFinite(requestedRetries) ? Math.max(0, requestedRetries) : 0;

// Обычные mobile E2E моделируют уже сделанный пользователем выбор «продолжить в браузере».
// Fullscreen/onboarding поведение запускается отдельным mobile-fullscreen project без этого флага.
const windowedMobileStorage = {
  cookies: [],
  origins: [
    {
      origin: 'http://127.0.0.1:4173',
      localStorage: [{ name: 'wobble-fullscreen-prompt-v1', value: '1' }]
    }
  ]
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  // Детерминированные сценарии в CI не повторяем: первый failure уже является сигналом.
  // Только отдельный long/full-match job получает один retry через WOBBLE_E2E_RETRIES=1.
  retries: process.env.CI ? ciRetries : 0,
  reporter: process.env.CI
    ? [['github'], ['./scripts/playwright-ci-summary.mjs'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: desktopIgnore,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions,
        // E2E идёт через один локальный сервер. Разные тестовые адреса не дают desktop-проекту
        // исчерпать production rate-limit аккаунтов до запуска mobile-проекта.
        extraHTTPHeaders: { 'x-forwarded-for': '192.0.2.10' }
      }
    },
    {
      name: 'mobile-chromium',
      testIgnore: [fullscreenSuite, fullMatchSuite, portalSuite],
      use: {
        ...devices['Pixel 7'],
        // Продукт теперь landscape-first: базовый мобильный project проверяет рабочую ориентацию и
        // обычные E2E с уже выбранным windowed mode. Fullscreen lifecycle закреплён отдельно ниже.
        viewport: { width: 915, height: 412 },
        screen: { width: 915, height: 412 },
        storageState: windowedMobileStorage,
        launchOptions,
        extraHTTPHeaders: { 'x-forwarded-for': '192.0.2.11' }
      }
    },
    {
      name: 'mobile-fullscreen',
      testMatch: fullscreenSuite,
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 915, height: 412 },
        screen: { width: 915, height: 412 },
        launchOptions,
        extraHTTPHeaders: { 'x-forwarded-for': '192.0.2.12' }
      }
    }
  ],
  webServer: [
    {
      // Тот же preload, что у production и `npm start`. Без него E2E гоняет сервер, у которого нет
      // моста `CLIENT_INPUT` → серверная симуляция: сквозной путь «браузер → WebSocket → симуляция»
      // не проверяется вовсе, а набор при этом зелёный. Юнит-тесты моста грузят preload сами, так
      // что дыра была именно в сквозной проверке — там, где её тяжелее всего заметить.
      command: 'node --require ./server/shadowInputPreload.js server/bootstrap.js',
      url: 'http://127.0.0.1:4173/health/ready',
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
      env: {
        HOST: '127.0.0.1',
        PORT: '4173',
        COOKIE_SECURE: '0',
        // Fake rewarded provider разрешён только локальному Playwright-серверу. Production остаётся
        // выключенным по умолчанию; тест использует его, чтобы получить настоящую server-owned
        // косметику без тестового backdoor в inventory.
        ENABLE_DEV_REWARDS: '1',
        // Только локальный Playwright-сервер доверяет тестовому X-Forwarded-For. Production по
        // умолчанию по-прежнему использует реальный remoteAddress и те же защитные лимиты.
        TRUST_PROXY: '1',
        // База своя и только на время прогона. Значение совпадает с умолчанием сервера, но задано
        // здесь ЯВНО: `webServer.env` дополняет окружение вызывающего, а не заменяет его, поэтому
        // экспортированный в оболочке LEADERBOARD_DB иначе достался бы и тестовому серверу.
        //
        // Цена ошибки выросла вместе с укорочением трассы: забег E2E короче обычного, а ключ таблицы
        // рекордов — это seed:difficulty без длины (см. courseKeyFor), то есть тестовые времена легли
        // бы в таблицу настоящей трассы того же сида и оказались там непобиваемыми. Сквозной тест
        // намеренно доводит оба результата до подтверждённой таблицы — это его проверка, — и вот его
        // записям и полагается жить ровно столько, сколько живёт сам прогон.
        LEADERBOARD_DB: ':memory:',
        // Трасса гонки в обычной работе случайная. Браузерный тест проходит её до финиша живым
        // управлением, и на случайной трассе он означал бы разное каждый прогон — то падал бы, то нет.
        //
        // Сид не «какой попался», а подобранный замером под простого водителя теста, и трёх сегментов
        // ему хватает: два настоящих Chromium на одной машине выдают 10–15 кадров в секунду, и полная
        // трасса перестаёт укладываться в бюджет — не из-за игры, а из-за раннера.
        //
        // Подробности — в server/e2eCourse.js (чем ограничено укорочение и почему оно не игровая
        // настройка) и в server/e2eCourse.test.mjs, где план этой трассы закреплён инвариантом.
        WOBBLE_E2E: '1',
        WOBBLE_E2E_SEGMENTS: '3',
        WOBBLE_FIXED_SEED: '130'
      }
    }
  ]
});
