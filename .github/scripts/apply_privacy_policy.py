from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path, old, new):
    file = ROOT / path
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one patch anchor, found {count}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "client/index.html",
    """        <div class=\"menu-footer\">\n          <button id=\"installApp\" class=\"icon-button hidden\" type=\"button\">УСТАНОВИТЬ</button>\n          <button id=\"quality\" class=\"icon-button\" aria-label=\"Изменить качество графики\">\n            АВТО КАЧЕСТВО\n          </button>\n          <button id=\"openSettings\" class=\"icon-button\" aria-label=\"Настройки управления\">УПРАВЛЕНИЕ</button>\n          <span id=\"controlHint\">WASD · ПРОБЕЛ · SHIFT · МЫШЬ — КАМЕРА</span>\n        </div>\n""",
    """        <div class=\"menu-footer\">\n          <button id=\"installApp\" class=\"icon-button hidden\" type=\"button\">УСТАНОВИТЬ</button>\n          <button id=\"quality\" class=\"icon-button\" aria-label=\"Изменить качество графики\">\n            АВТО КАЧЕСТВО\n          </button>\n          <button id=\"openSettings\" class=\"icon-button\" aria-label=\"Настройки управления\">УПРАВЛЕНИЕ</button>\n          <span id=\"controlHint\">WASD · ПРОБЕЛ · SHIFT · МЫШЬ — КАМЕРА</span>\n        </div>\n        <div class=\"legal-links\" aria-label=\"Документы Wobble Rush\">\n          <a href=\"/privacy/\" target=\"_blank\" rel=\"noopener\">ПОЛИТИКА КОНФИДЕНЦИАЛЬНОСТИ</a>\n        </div>\n""",
)

replace_once(
    "client/styles.css",
    """.menu-footer span {\n  font-size: 8px;\n  color: #9996c4;\n  letter-spacing: 0.08em;\n}\n.icon-button,\n""",
    """.menu-footer span {\n  font-size: 8px;\n  color: #9996c4;\n  letter-spacing: 0.08em;\n}\n.legal-links {\n  display: flex;\n  justify-content: center;\n  margin-top: 9px;\n}\n.legal-links a {\n  padding: 4px 6px;\n  border-radius: 7px;\n  color: #a9a5cf;\n  font-size: 8px;\n  font-weight: 900;\n  letter-spacing: 0.08em;\n  text-decoration: none;\n}\n.legal-links a:hover,\n.legal-links a:focus-visible {\n  color: #fff;\n  background: #ffffff0d;\n  outline: 2px solid #4ce0df88;\n  outline-offset: 2px;\n}\n.icon-button,\n""",
)

replace_once(
    "package.json",
    "server/pwa.test.mjs server/observability.test.mjs",
    "server/pwa.test.mjs server/privacyPage.test.mjs server/observability.test.mjs",
)

privacy = r'''<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
    <meta name="theme-color" content="#4b35b7" />
    <meta
      name="description"
      content="Политика конфиденциальности Wobble Rush: гостевой режим, аккаунты, Google Sign-In и игровые данные."
    />
    <link rel="canonical" href="https://wobbles.ru/privacy/" />
    <title>Политика конфиденциальности — Wobble Rush</title>
    <style>
      :root {
        color-scheme: dark;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #17122b;
        color: #f7f4ff;
      }
      * {
        box-sizing: border-box;
      }
      html {
        min-height: 100%;
        background:
          radial-gradient(circle at 15% 0%, #5a3ac933, transparent 34rem),
          linear-gradient(180deg, #1b1435, #120e24 55%, #0d0b18);
      }
      body {
        min-height: 100vh;
        margin: 0;
        padding: max(24px, env(safe-area-inset-top)) max(18px, env(safe-area-inset-right))
          max(36px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left));
        line-height: 1.65;
      }
      main {
        width: min(860px, 100%);
        margin: 0 auto;
      }
      header,
      article {
        border: 1px solid #ffffff1f;
        border-radius: 24px;
        background: #20183ce8;
        box-shadow: 0 22px 60px #09061266;
      }
      header {
        padding: clamp(24px, 5vw, 48px);
        background:
          radial-gradient(circle at 100% 0%, #4ce0df1f, transparent 20rem),
          linear-gradient(145deg, #5135c5e8, #261957f2);
      }
      article {
        margin-top: 18px;
        padding: clamp(22px, 4vw, 42px);
      }
      h1,
      h2,
      h3 {
        line-height: 1.15;
      }
      h1 {
        margin: 8px 0 12px;
        font-size: clamp(2rem, 7vw, 3.8rem);
        letter-spacing: -0.045em;
      }
      h2 {
        margin: 2.2rem 0 0.75rem;
        color: #ffe16b;
        font-size: 1.35rem;
      }
      h3 {
        margin: 1.4rem 0 0.5rem;
        color: #8af1eb;
        font-size: 1.02rem;
      }
      p,
      li {
        color: #ded9f3;
      }
      ul {
        padding-left: 1.35rem;
      }
      a {
        color: #8af1eb;
      }
      a:hover,
      a:focus-visible {
        color: #fff;
      }
      .eyebrow {
        margin: 0;
        color: #8af1eb;
        font-size: 0.76rem;
        font-weight: 900;
        letter-spacing: 0.18em;
      }
      .lead {
        max-width: 70ch;
        margin-bottom: 0;
        color: #fff;
        font-size: 1.05rem;
      }
      .meta {
        margin-top: 18px;
        color: #b8b0d5;
        font-size: 0.84rem;
      }
      .notice {
        margin: 1.25rem 0;
        padding: 14px 16px;
        border: 1px solid #4ce0df33;
        border-radius: 14px;
        background: #4ce0df0b;
      }
      .lang-divider {
        margin: 3rem 0 2rem;
        border: 0;
        border-top: 1px solid #ffffff24;
      }
      .home {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 16px;
        padding: 8px 12px;
        border: 1px solid #ffffff28;
        border-radius: 999px;
        color: #fff;
        background: #ffffff0c;
        font-size: 0.82rem;
        font-weight: 800;
        text-decoration: none;
      }
      footer {
        padding: 22px 8px 0;
        color: #9991bb;
        font-size: 0.8rem;
        text-align: center;
      }
      code {
        color: #fff;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
    </style>
  </head>
  <body>
    <main>
      <a class="home" href="/">← Вернуться в Wobble Rush</a>
      <header>
        <p class="eyebrow">WOBBLE RUSH · PRIVACY</p>
        <h1>Политика конфиденциальности</h1>
        <p class="lead">
          Wobble Rush собирает только данные, необходимые для игры, аккаунта, безопасности и
          устойчивой работы сервиса. Гостевой режим доступен без Google-аккаунта.
        </p>
        <p class="meta">Действует с 14 августа 2026 года · Последнее обновление: 14 августа 2026 года</p>
      </header>

      <article>
        <h2>1. Что обрабатывает Wobble Rush</h2>
        <h3>Гостевой режим</h3>
        <p>
          Можно играть без входа. Личные настройки и гостевые рекорды хранятся в данных браузера на
          вашем устройстве. Очистка данных сайта может удалить этот локальный прогресс. Для сетевой
          игры сервер всё равно обрабатывает необходимые игровые сообщения и технические данные
          соединения.
        </p>

        <h3>Аккаунт Wobble</h3>
        <p>После входа или создания аккаунта сервер может хранить:</p>
        <ul>
          <li>внутренний идентификатор аккаунта и выбранное отображаемое имя;</li>
          <li>хеш кода восстановления и защищённые данные сессий;</li>
          <li>личные рекорды, достижения, игровую статистику, инвентарь и выбранную косметику;</li>
          <li>данные онлайн-матчей, необходимые для таблиц рекордов, подбора игроков и восстановления соединения;</li>
          <li>
            данные безопасности и модерации, когда это применимо: жалобы, исключения игроков,
            санкции и историю действий поддержки;
          </li>
          <li>ограниченные диагностические события, необходимые для расследования сбоев.</li>
        </ul>

        <h3>Вход через Google</h3>
        <p>
          Для Google Sign-In используется Google Identity Services. Wobble получает подписанное Google
          удостоверение личности и проверяет его на сервере. Для постоянной связи с игровым аккаунтом
          хранится стабильный идентификатор Google-аккаунта (<code>sub</code>) и имя провайдера
          <code>google</code>. Имя из Google-профиля может использоваться как начальное игровое имя при
          создании нового аккаунта.
        </p>
        <div class="notice">
          Wobble Rush не запрашивает пароль Google и не получает доступ к Gmail, Google Drive,
          Calendar, Contacts или другим файлам и сервисам Google. Для входа используются только
          базовые OpenID Connect данные: <code>openid</code>, <code>email</code> и <code>profile</code>.
        </div>

        <h3>Технические данные</h3>
        <p>
          Сервер и reverse proxy могут обрабатывать IP-адрес и стандартные HTTP/WebSocket метаданные
          для установления соединения, защиты от злоупотреблений, ограничения частоты запросов,
          диагностики и эксплуатации сервиса. Wobble Control намеренно исключает токены, пароли,
          Google credentials и произвольные игровые payload из операторских alert/diagnostic данных.
        </p>

        <h2>2. Для чего используются данные</h2>
        <ul>
          <li>для входа, сохранения прогресса и переноса аккаунта между устройствами;</li>
          <li>для онлайн-игры, кооператива, матчмейкинга и таблиц рекордов;</li>
          <li>для выдачи достижений и косметических наград;</li>
          <li>для защиты аккаунтов и сервера от злоупотреблений;</li>
          <li>для модерации, поддержки игроков, диагностики сбоев и резервного восстановления;</li>
          <li>для агрегированных технических метрик, помогающих поддерживать игру работоспособной.</li>
        </ul>

        <h2>3. Cookies и локальное хранилище</h2>
        <p>
          Вошедший аккаунт использует защищённую HTTP-only cookie сессии. Гостевой прогресс,
          настройки устройства и часть локального состояния игры могут храниться браузером на вашем
          устройстве. Wobble не использует рекламные cookies для профилирования игроков.
        </p>

        <h2>4. Срок хранения</h2>
        <p>
          Данные аккаунта и игрового прогресса хранятся, пока они нужны для работы аккаунта или пока
          не выполнен запрос на удаление. Сессии имеют ограниченный срок действия. Диагностические и
          операционные данные ограничиваются отдельными сроками и/или объёмом; часть данных может
          временно сохраняться в резервных копиях до их обычной ротации.
        </p>

        <h2>5. Передача третьим сторонам</h2>
        <p>
          Google используется как поставщик идентификации при добровольном входе через Google.
          Инфраструктурные и сетевые провайдеры могут обрабатывать технические данные в объёме,
          необходимом для размещения и доставки сервиса. Wobble Rush не продаёт персональные данные и
          не использует их для сторонней рекламной персонализации.
        </p>

        <h2>6. Ваш выбор и ваши данные</h2>
        <ul>
          <li>можно продолжать играть гостем без Google Sign-In;</li>
          <li>можно выйти из аккаунта и отзывать другие активные сессии;</li>
          <li>можно заменить код восстановления аккаунта;</li>
          <li>
            запрос на доступ, исправление или удаление данных аккаунта можно отправить по адресу
            <a href="mailto:mshakhmerzayev@gmail.com">mshakhmerzayev@gmail.com</a>;
          </li>
          <li>
            отключение Wobble Rush в настройках Google прекращает соответствующее разрешение у
            Google, но само по себе не удаляет игровой аккаунт Wobble; для удаления используйте
            контакт выше.
          </li>
        </ul>

        <h2>7. Безопасность</h2>
        <p>
          Сервис использует HTTPS, HTTP-only cookies, хеширование секретов и сессионных токенов,
          ограничение частоты запросов и раздельные операционные контуры. Ни один способ хранения не
          может гарантировать абсолютную безопасность, поэтому доступ к данным ограничивается тем,
          что необходимо для работы сервиса.
        </p>

        <h2>8. Изменения этой политики</h2>
        <p>
          При существенных изменениях обработки данных эта страница будет обновлена, а дата вверху
          изменится. Актуальная версия всегда доступна по адресу
          <a href="https://wobbles.ru/privacy/">https://wobbles.ru/privacy/</a>.
        </p>

        <hr class="lang-divider" />

        <p class="eyebrow">ENGLISH SUMMARY</p>
        <h2>Privacy Policy</h2>
        <p>
          Wobble Rush can be played as a guest without Google Sign-In. Guest records and settings are
          stored in the browser. A signed-in Wobble account may store an internal account ID, display
          name, hashed recovery/session secrets, gameplay records, achievements, inventory, online
          match data and safety/moderation records needed to operate the service.
        </p>
        <p>
          Google Identity Services is optional. Wobble verifies Google's signed identity credential
          server-side and stores the stable Google subject identifier (<code>sub</code>) as the link to
          the Wobble account. The Google profile name may be used as the initial in-game display name.
          Wobble does not request the Google password or access to Gmail, Drive, Calendar, Contacts or
          other Google services. The configured identity scopes are <code>openid</code>,
          <code>email</code> and <code>profile</code>.
        </p>
        <p>
          Network identifiers and normal HTTP/WebSocket metadata may be processed for connectivity,
          security, rate limiting and operations. Wobble Rush does not sell personal data or use it
          for third-party advertising personalization. Account data requests, including deletion
          requests, can be sent to
          <a href="mailto:mshakhmerzayev@gmail.com">mshakhmerzayev@gmail.com</a>.
        </p>
        <p>
          The Russian sections above provide the fuller description of purposes, retention, security
          and user choices. The current policy is always published at
          <a href="https://wobbles.ru/privacy/">https://wobbles.ru/privacy/</a>.
        </p>
      </article>

      <footer>© 2026 Wobble Rush · <a href="/">wobbles.ru</a></footer>
    </main>
  </body>
</html>
'''

privacy_path = ROOT / "client/privacy/index.html"
privacy_path.parent.mkdir(parents=True, exist_ok=True)
privacy_path.write_text(privacy, encoding="utf-8")

test = r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        headers: { accept: 'text/html' }
      },
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
  });
}

test('privacy policy is public, canonical and linked from the game', async t => {
  const homepage = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
  const policy = fs.readFileSync(path.join(root, 'client', 'privacy', 'index.html'), 'utf8');

  assert.match(homepage, /href="\/privacy\/"/);
  assert.match(policy, /<link rel="canonical" href="https:\/\/wobbles\.ru\/privacy\/" \/>/);
  assert.match(policy, /Google Identity Services/);
  assert.match(policy, /openid/);
  assert.match(policy, /userinfo\.email|<code>email<\/code>/);
  assert.match(policy, /profile/);
  assert.doesNotMatch(policy, /<script\b/i);
  assert.doesNotMatch(policy, /GOOGLE_CLIENT_SECRET|client secret/i);

  const core = require('./index.js');
  if (!core.server.listening) {
    await new Promise((resolve, reject) => {
      core.server.once('error', reject);
      core.server.listen(0, '127.0.0.1', resolve);
    });
  }
  t.after(
    () =>
      new Promise(resolve => {
        if (!core.server.listening) return resolve();
        core.server.close(() => resolve());
      })
  );

  const address = core.server.address();
  const port = Number(address?.port);
  assert.ok(Number.isSafeInteger(port) && port > 0);

  const redirect = await request(port, '/privacy');
  assert.equal(redirect.status, 301);
  assert.match(String(redirect.headers.location || ''), /\/privacy\/$/);

  const page = await request(port, '/privacy/');
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-type'] || ''), /^text\/html/);
  assert.match(page.body, /Политика конфиденциальности/);
  assert.match(page.body, /Privacy Policy/);
  assert.match(String(page.headers['content-security-policy'] || ''), /default-src 'self'/);
});
'''

(ROOT / "server/privacyPage.test.mjs").write_text(test, encoding="utf-8")
