import { defineConfig, devices } from '@playwright/test';

// Путь к браузеру можно задать снаружи. В готовых окружениях Chromium уже установлен, и его сборка
// не обязана совпадать с той, которую скачал бы сам Playwright под версию пакета. В CI переменная не
// задаётся — там браузер ставится шагом `playwright install`.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const launchOptions = executablePath ? { executablePath } : {};
const fullscreenSuite = /mobile-landscape\.spec\.js/;

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
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: fullscreenSuite,
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
      testIgnore: fullscreenSuite,
      use: {
        ...devices['Pixel 7'],
        // Продукт теперь landscape-first: базовый мобильный проект проверяет именно рабочую
        // ориентацию, а fullscreen/portrait lifecycle закреплён отдельным project ниже.
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
  webServer: {
    command: 'node server/bootstrap.js',
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
});
