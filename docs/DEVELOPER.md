# Руководство разработчика Wobble Rush

## 1. Технологический контур

Wobble Rush — браузерная Three.js-игра на обычных ES-модулях, Node.js, Express и WebSocket. Для
production-данных используется встроенный `node:sqlite`; минимальная версия Node указана в
`package.json` и сейчас равна `>= 22.5`.

Клиент и сервер обновляются вместе. `shared/protocol.js` — единый источник типов и схем сетевых
сообщений, а `shared/validation.js` применяет эти схемы механически.

## 2. Структура

```text
client/
  audio/      звук и музыка
  core/       account flow, config, input, settings, quality, PWA
  game/       физика, трассы, кооп, персонаж, камера
  net/        WebSocket, clock sync, snapshot buffer
  ui/         меню и HUD

server/
  bootstrap.js           production entrypoint
  index.js               HTTP/WebSocket core
  accounts.js            аккаунты и прогресс
  auth.js                sessions / identities / WST
  authRoutes.js          Auth V2 HTTP API
  accountSelfService.js  active sessions и recovery rotation
  db.js                  SQLite
  verifiedLeaderboard.js trusted competitive leaderboard
  metrics.js             gameplay analytics
  moderation.js          moderation model
  backup*.js/mjs         backup infrastructure
  migrations/            numbered schema migrations

shared/
  protocol.js
  validation.js
  courseSpec.js
  courseProgress.js
  coopChapters.js
  cosmetics.js

deploy/
  install.sh
  restore.sh
  smoke.sh
  systemd/nginx templates

e2e/
  Playwright scenarios
```

## 3. Локальный запуск

```bash
git clone https://github.com/Malikk-Sh/Fall-guys.git
cd Fall-guys
npm ci
npm start
```

Откройте `http://localhost:3000`.

Основные scripts:

```bash
npm start
npm run dev
npm run format
npm run format:check
npm run lint
npm test
npm run test:e2e
npm run test:e2e:desktop
npm run load
```

Для воспроизводимой установки зависимостей используйте `npm ci`. `npm install` нужен, когда вы
осознанно меняете dependency graph и lock-файл.

## 4. Git workflow

```bash
git switch main
git pull --ff-only
git switch -c feat/short-description
```

Перед push:

```bash
npm run format
npm run lint
npm test
git diff --check
git status
```

После этого commit, push и PR в `main`. Не обходите красный CI ручным merge.

## 5. CI

Workflow `Verify Wobble Rush` проверяет:

1. exact dependencies через `npm ci`;
2. Prettier и merge-conflict markers;
3. синтаксис production shell scripts;
4. shared-443 Nginx configuration;
5. ESLint;
6. полный Node test suite;
7. production backup + smoke;
8. Playwright multiplayer/E2E.

Локальный минимум перед PR:

```bash
npm ci
npm run format:check
npm run check
npm test
npx playwright install chromium
npm run test:e2e:desktop
```

### Трасса сквозных тестов

`e2e/full-match.spec.js` проходит настоящий забег в двух браузерах, поэтому трасса под ним
зафиксирована. Задаётся она окружением сервера в `playwright.config.js`:

| Переменная            | Что делает                                                      |
| --------------------- | --------------------------------------------------------------- |
| `WOBBLE_FIXED_SEED`   | сид трассы вместо случайного                                    |
| `WOBBLE_E2E`          | тестовый флаг; без него `WOBBLE_E2E_SEGMENTS` не читается вовсе |
| `WOBBLE_E2E_SEGMENTS` | длина трассы, только короче собственной длины сложности         |

Укорочение — уступка раннеру, а не игре: два Chromium на одной машине дают 10–15 FPS, и при
пяти подшагах физики на кадр полная трасса перестаёт укладываться в бюджет теста. Двойной флаг
нужен, чтобы случайная переменная на боевом сервере не могла изменить длину публичной гонки; в
`deploy/wobble.env.example` ни одной из них нет. Правило и его границы — `server/e2eCourse.js`.

Сид подобран замером под намеренно простого водителя теста, а не наугад. План выбранной трассы
закреплён инвариантом в `server/e2eCourse.test.mjs`: если генератор изменится, упадёт он — за долю
секунды и с внятным сообщением, а не Playwright через двенадцать минут. Подобрать новый сид:

```bash
node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
SEED=<кандидат> node --experimental-loader ./server/client-loader.mjs tools/e2eSeedVerify.mjs
```

Проходимость настоящих трасс со всеми препятствиями за этими тестами не закреплена — её проверяют
`server/raceBot.test.mjs` и `server/traverse.test.mjs`, без браузера и на десятках сидов.

## 6. Server-authoritative границы

Всё, что влияет на ценность аккаунта или competitive result, должно подтверждаться сервером:

- server-timed финиш и trusted leaderboard;
- campaign progress;
- inventory и loadout ownership;
- reward grants;
- account/session identity;
- social history и moderation evidence.

Клиент не должен иметь API, которым можно объявить себе пройденную главу, награду или trusted record.

При новом server-authoritative feature проверяйте:

- сервер валидирует ownership/state;
- повторный request не дублирует reward;
- связанные изменения выполняются транзакционно;
- malicious client покрыт тестом;
- recovery code и persistent session bearer не входят в gameplay messages; одноразовый WST допустим
  только в выделенном socket-auth обмене.

### Прогресс: одна геометрия на сервере, мягкий клиент

Чекпоинт и финиш — граница результата, и решает её сервер. Геометрия пересечения при этом обязана
быть у всех серверных проверок **буквально одна** — `shared/courseProgress.js`. Проверок на одном
отрезке несколько (выдача чекпоинта в `validateState`, коридор в `raceProgressSpatialGuard`, регион
кооператива в `verifyCoopCheckpoint`), и разъехавшись, они начинают спорить друг с другом: точка
сохраняется, а проверка главы снимается за то же самое движение.

Правила:

- рамки читаются В ПЛОСКОСТИ арки (интерполяцией), а не на состоянии после неё, — иначе результат
  зависит от частоты выборки, то есть от качества связи игрока;
- второго места, знающего про геометрию пересечения, заводить нельзя.

Счётчик чекпоинтов на КЛИЕНТЕ — предсказание, а не решение, и у него есть обязанность, которой нет
у решения: он должен уметь **догнать** сервер. Клиентское «я за чертой?» это умеет; проверка
пересечения — нет, она срабатывает один раз. Отставший клиент не пошлёт финиш вовсе, и починить это
нечем: обратного механизма не существует. Обратный случай — клиент ушёл вперёд — сервер чинит сам
(`finishRejection`). Поэтому **клиент намеренно мягче сервера, и делать его строже нельзя**, пока не
появится авторитетная синхронизация счётчика.

Эффективную рамку в гонке задаёт не `CHECKPOINT_HALF_WIDTH`, а коридор: в бою
`raceCheckpointAuthorityCoreBridge` установлен поверх `validateState` через `shadowInputPreload.js`
и откатывает выдачу до `corridorHalfWidth + CORRIDOR_MARGIN`. Это общая граница результата, а не
shadow-путь, — при правке рамок смотрите на неё, а не только на `validateState`.

**Кооператива коридор не касается вовсе.** `isRaceCourseSpec` требует поля `segments`, которого у
глав нет, поэтому рабочая рамка выдачи в кооперативе — та, что стоит в `validateState`. Долгое время
это была гоночная рамка, а проверка результата шла по своей, кооперативной, — и промежуток между
ними работал ловушкой: пересечение сбоку от дорожки чекпоинт выдавало и тем же движением снимало
проверку со всей главы. Теперь рамка выбирается по спеке (`COOP_CHECKPOINT_FRAME` против
`RACE_CHECKPOINT_FRAME`), выдача и проверка читают одну, а прежняя региональная проверка осталась
сторожевой: сойтись они обязаны по построению, и её срабатывание означает, что рамки снова
разъехались.

## 7. Сетевой протокол

Источник истины:

```text
shared/protocol.js
shared/validation.js
```

`PROTOCOL_VERSION` нужно повышать при несовместимом изменении схемы. При version mismatch сервер
должен отклонить старый клиент понятно, а не продолжить частично выполнять сообщения.

Checklist протокольного изменения:

1. изменить schema/message type;
2. решить, backward-compatible ли изменение;
3. при необходимости поднять `PROTOCOL_VERSION`;
4. обновить server handler;
5. обновить client handler;
6. добавить protocol test;
7. добавить integration/E2E там, где изменение проходит через реальный socket;
8. проверить stale-client scenario.

Не добавляйте долгий cache для `client/` и `shared/`: после deploy старый client не должен долго
говорить с новым server protocol.

## 8. Auth V2

Модель аккаунта:

- server-generated recovery code;
- HttpOnly persistent session cookie для обычных запросов;
- короткий одноразовый WebSocket ticket (WST) только для socket-auth.

Recovery code — recovery credential, а не обычный request credential. WST, напротив, специально
возвращается как `networkTicket` в authenticated HTTP response и затем один раз передаётся в
`C2S.AUTH`; после успешного bind gameplay messages используют уже `ws.accountId` без credential.

Active sessions и staged recovery rotation подробно описаны в
[`ACCOUNT-SELF-SERVICE.md`](ACCOUNT-SELF-SERVICE.md). При изменении auth-кода обязательно проверяйте:

- raw persistent session bearer не входит в JSON;
- recovery code не используется как обычный gameplay credential;
- session cookie остаётся HttpOnly;
- WST одноразовый, короткоживущий и используется только для socket-auth;
- destructive actions имеют явное подтверждение;
- потеря HTTP-ответа не уничтожает единственный recovery path.

## 9. SQLite и миграции

Production DB находится вне checkout, обычно в `/var/lib/wobble/leaderboard.db`.

Для файловой БД используется WAL. Не делайте backup обычным копированием только `leaderboard.db`:
часть committed state может ещё находиться в WAL.

Миграции находятся в `server/migrations/` и идут строго по номеру. Правила:

1. уже выпущенную migration не переписывать;
2. следующая schema change получает следующий номер;
3. migration и запись в `schema_migrations` должны быть атомарны;
4. добавить regression test upgrade path;
5. проверить повторный startup;
6. проверить совместимость backup verifier.

Нельзя "откатить" schema удалением строки из `schema_migrations`: это лишь делает metadata ложной.

## 10. Competitive records

`verifiedLeaderboard.js` хранит только серверно подтверждённые competitive records. Verification
имеет собственную version, независимую от package/protocol/schema versions.

При ужесточении verifier старые записи нельзя задним числом считать проверенными новым алгоритмом
без явного доказательства. Не меняйте `verification_version` вручную в SQLite.

## 11. Gameplay analytics

`server/metrics.js` намеренно агрегирует события по bounded dimensions и не добавляет account ID.
Если вам нужна новая dimension, убедитесь, что она:

- имеет ограниченный набор значений;
- не содержит unique player/session identifier;
- не превращает pending metric map в неограниченную cardinality.

`dropped > 0` в `/metrics/gameplay` обычно означает ошибку instrumentation, а не просто большой онлайн.

## 12. Что тестировать на реальных устройствах

Перед заметным release минимум:

- Chromium desktop;
- второй браузер/инкогнито;
- Android Chrome;
- два физических клиента одновременно.

Сценарии:

- create/join room;
- matchmaking;
- full race;
- full co-op;
- disconnect/reconnect;
- host migration;
- rematch/next chapter;
- account sign-in;
- active sessions;
- recovery rotation;
- explicit logout.

## 13. Checklist production-sensitive PR

```text
[ ] Понятна server-authoritative граница
[ ] Recovery code и persistent session bearer не попадают в JSON/gameplay messages
[ ] Одноразовый WST используется только как networkTicket -> C2S.AUTH для socket-auth
[ ] Есть unit/integration test
[ ] Есть E2E, если меняется пользовательский сетевой сценарий
[ ] Миграция добавлена новым номером, если меняется schema
[ ] Protocol version обновлён, если изменение несовместимо
[ ] Backup/restore semantics не ухудшены
[ ] Deploy impact описан
[ ] Docs обновлены в том же PR
[ ] После deploy перечислены конкретные smoke checks
```
