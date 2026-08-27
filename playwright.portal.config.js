import { defineConfig, devices } from '@playwright/test';

// Портальный билд гоняется ОТДЕЛЬНОЙ конфигурацией, а не отдельным проектом внутри общей.
//
// Причина в том, что `webServer` в Playwright — настройка конфигурации, а не проекта: раздачи
// поднимаются все и до того, как применён фильтр `--project`. Пока портальная раздача жила в общем
// массиве, любая точечная команда (`test:e2e:desktop`, `test:e2e:menu`) собирала и поднимала
// портальный билд, которого её тесты не касаются, а поломка сборки роняла бы посторонний набор.
// Проверено запуском: `--project=chromium` без единого портального теста поднимал раздачу на 4174.
//
// Обратное тоже верно и тоже ценно: портальному набору не нужен наш игровой сервер. Здесь он и не
// поднимается — а значит, набор физически не может пройти за счёт того, что рядом кто-то отвечает.

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const launchOptions = executablePath ? { executablePath } : {};

const PORT = Number(process.env.WOBBLE_PORTAL_PORT || 4174);
const baseURL = `http://127.0.0.1:${PORT}`;

// Мобильный проект моделирует уже сделанный игроком выбор «продолжить в окне»: полноэкранный
// вопрос живёт в MobileExperience и на площадке тоже показывается, но предмет этого набора —
// портальный билд, а не поведение того вопроса (оно закреплено проектом mobile-fullscreen).
const windowedMobileStorage = {
  cookies: [],
  origins: [{ origin: baseURL, localStorage: [{ name: 'wobble-fullscreen-prompt-v1', value: '1' }] }]
};

export default defineConfig({
  testDir: './e2e',
  testMatch: /portal\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: process.env.CI
    ? [['github'], ['./scripts/playwright-ci-summary.mjs'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'portal',
      use: { ...devices['Desktop Chrome'], launchOptions }
    },
    {
      // Аудитория площадки мобильная, и проверять билд только настольным браузером значило бы
      // объявлять защищённым то, чего набор не касается. Ориентация та же landscape, что и в
      // обычном мобильном проекте: продукт landscape-first.
      name: 'portal-mobile',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 915, height: 412 },
        screen: { width: 915, height: 412 },
        storageState: windowedMobileStorage,
        launchOptions
      }
    }
  ],
  webServer: {
    // Раздача с ПОДПУТИ — так игру отдаёт площадка. Наш сервер монтирует клиент, `shared/` и движок
    // из трёх разных мест; площадка не монтирует ничего, ей уезжает архив.
    command: 'node scripts/servePortalBuild.mjs',
    url: `${baseURL}/health`,
    // Переиспользования нет намеренно. Эта же команда СОБИРАЕТ `dist/yandex`, поэтому уцелевший от
    // прошлого прогона процесс раздавал бы старое дерево и набор зеленел бы на давно изменённых
    // исходниках. Сборка занимает доли секунды — цена ниже, чем цена такого зелёного.
    reuseExistingServer: false,
    timeout: 30_000
  }
});
