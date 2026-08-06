import { defineConfig, devices } from '@playwright/test';

// Путь к браузеру можно задать снаружи. В готовых окружениях Chromium уже установлен, и его сборка
// не обязана совпадать с той, которую скачал бы сам Playwright под версию пакета. В CI переменная не
// задаётся — там браузер ставится шагом `playwright install`.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const launchOptions = executablePath ? { executablePath } : {};

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
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], launchOptions } }
  ],
  webServer: {
    command: 'node server/index.js',
    url: 'http://127.0.0.1:4173/health/ready',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
    env: {
      HOST: '127.0.0.1',
      PORT: '4173',
      // Трасса гонки в обычной работе случайная. Браузерный тест проходит её до финиша живым
      // управлением, и на случайной трассе он означал бы разное каждый прогон — то падал бы, то нет.
      //
      // Сид выбран замером, а не наугад: на лёгкой трассе он даёт план без «узкого поворота», и бот
      // проходит её за 19–21 секунду в пяти прогонах подряд, оба игрока.
      WOBBLE_FIXED_SEED: '8'
    }
  }
});
