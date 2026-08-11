# Wobble Rush Control Plane

## Назначение

`/admin/` — отдельная интерактивная панель владельца проекта, операторов, модераторов и аналитиков.
Она не использует игровой recovery code и не повышает обычный аккаунт игрока до администратора.

Control Plane показывает production health, build/release identity, нагрузку, аккаунты, gameplay
metrics, moderation workflow и admin audit history. Системные действия уровня backup/restart/deploy
будут подключаться отдельными PR поверх этой границы безопасности.

Интерфейс специально рассчитан не только на разработчика. Возле сложных разделов есть раскрываемые
объяснения, технические названия сопровождаются понятными русскими подписями, а опасные действия
описывают, что именно произойдёт до подтверждения.

## Первый вход на production — пошагово

Панель находится по адресу:

```text
https://wobbles.ru/admin/
```

Но production panel выключена по умолчанию. Первый запуск состоит из трёх отдельных шагов.

### 1. Обновить Wobble

На VPS:

```bash
bash /opt/wobble/deploy/install.sh
```

После успешного deploy migration 011 создаст admin tables. Самого администратора миграция
**не создаёт**.

### 2. Создать первого владельца

```bash
sudo -u wobble node /opt/wobble/server/adminCli.mjs \
  --db /var/lib/wobble/leaderboard.db \
  create --name Malik --role owner
```

Команда вернёт JSON с `user` и `accessCode`. `accessCode` показывается один раз. Сохраните его в
password manager. Не отправляйте его в Issues, PR, логи, moderator notes или обычный чат.

### 3. Включить панель

Откройте `/etc/wobble.env` и добавьте или измените:

```dotenv
ADMIN_PANEL_ENABLED=1
ADMIN_COOKIE_SECURE=1
```

Затем:

```bash
systemctl restart wobble
curl -fsS http://127.0.0.1:3000/health/live
```

После этого откройте:

```text
https://wobbles.ru/admin/
```

и введите только что созданный admin access code.

Игровой recovery code, пароль Google или данные VPN здесь не используются.

## Security model

- production panel выключена по умолчанию: `ADMIN_PANEL_ENABLED=0`;
- администраторы живут в отдельных таблицах `admin_users` / `admin_sessions`;
- access code генерируется сервером с высокой энтропией и показывается только при create/rotate;
- в SQLite хранится только SHA-256 hash access code;
- после входа браузер получает отдельную HttpOnly `wobble_admin_session` cookie только для
  `/api/admin`;
- production cookie имеет `Secure` и `SameSite=Strict`;
- все authenticated actions, кроме чтения собственной session metadata, требуют CSRF token;
- login throttling использует доверенный TCP peer, а не доступный клиенту `X-Forwarded-For`;
- в shared-443 production исходный client IP не доходит до HTTP backend, поэтому этот guard
  намеренно общий для admin login и не выдаётся за per-IP защиту;
- expired admin sessions очищаются при следующем login, одновременно на одного администратора
  хранится не больше 20 живых sessions;
- роли проверяются на сервере, скрытая кнопка в UI не является проверкой прав;
- admin mutations и соответствующие audit events фиксируются транзакционно;
- moderation transition и соответствующий `admin_audit_events` event выполняются одной SQLite
  transaction: если audit не записался, moderation case тоже не изменяется;
- recovery code игрока, player session bearer и VPN/Xray secrets к панели отношения не имеют.

Не добавляйте shell execution в Node process. Системные операции должны идти через будущий узкий
privileged helper с allowlist команд, а не через произвольную строку shell из HTTP request.

## Роли

| Role        | Что означает простыми словами                             |
| ----------- | --------------------------------------------------------- |
| `owner`     | владелец: полный доступ к разрешённым функциям панели     |
| `operator`  | оператор: наблюдение за сервером и модерацией без решений |
| `moderator` | модератор: просмотр жалоб и изменение их статуса          |
| `analyst`   | аналитик: обзор и игровая статистика                      |
| `viewer`    | наблюдатель: только безопасный обзор                      |

Capabilities проверяет `server/adminAuth.js`; frontend лишь отражает результат сервера.

## Управление администраторами

Список без секретов:

```bash
sudo -u wobble node /opt/wobble/server/adminCli.mjs \
  --db /var/lib/wobble/leaderboard.db list
```

Ротация access code одновременно отзывает все admin sessions этого пользователя:

```bash
sudo -u wobble node /opt/wobble/server/adminCli.mjs \
  --db /var/lib/wobble/leaderboard.db rotate <admin-id>
```

Отключить:

```bash
sudo -u wobble node /opt/wobble/server/adminCli.mjs \
  --db /var/lib/wobble/leaderboard.db disable <admin-id>
```

Вернуть доступ:

```bash
sudo -u wobble node /opt/wobble/server/adminCli.mjs \
  --db /var/lib/wobble/leaderboard.db enable <admin-id>
```

`disable` немедленно удаляет активные admin sessions. `enable` не восстанавливает старые sessions.

## Что видно в панели

### Обзор

Раздел объясняет показатели человеческими названиями и показывает:

- текущих игроков и комнаты;
- активные аккаунты за 24 часа;
- новые и уже рассматриваемые moderation cases;
- состояние backup;
- package version / commit / release;
- protocol version;
- uptime;
- event-loop p95, RSS и heap с пояснением, что это показатели нагрузки;
- socket/match capacity;
- matchmaking waiting;
- competitive leaderboard entry count.

Кнопка **Обновить данные** только перечитывает состояние. Она ничего не перезапускает.

### Статистика

Analytics теперь предназначена для обычного визуального анализа, а не только для чтения сырой
таблицы.

Можно выбрать:

- период: сегодня в реальном времени или последние 7 / 30 / 90 полных UTC-дней;
- режим;
- трассу или co-op главу;
- тип устройства: mobile / desktop.

Панель показывает:

- начатые матчи;
- завершённые матчи;
- отношение `finished / started`;
- выходы до финиша, включая отключение игрока, который не вернулся за reconnect grace period;
- падения;
- среднее server-verified finish time;
- сравнение каждого основного показателя с предыдущим периодом такой же длины, когда полный предыдущий период помещается в 90-дневное окно хранения;
- график по дням;
- топ мест падения;
- топ мест, после которых чаще бросают матч;
- подробную агрегированную таблицу.

«Сегодня» показывается в реальном времени без процентного сравнения со вчера: текущий день ещё не завершён. Для 7 и 30 дней сравниваются только полные календарные дни одинаковой длины. Для 90-дневного периода панель честно отключает сравнение с предыдущими 90 днями: gameplay metrics хранятся только 90 дней, поэтому полного предыдущего окна уже нет.

`finished / started` — это отношение обезличенных событий, а не strict unique-player funnel. Оно
может быть полезно для сравнения периодов, но его нельзя называть точным retention или conversion
rate уникальных пользователей.

Если `dropped > 0`, панель показывает предупреждение. Это обычно означает проблему с instrumentation:
код начал создавать слишком много уникальных dimension keys.

#### Export

Кнопки **Скачать CSV** и **Скачать JSON** работают в браузере и экспортируют только уже разрешённую
агрегированную analytics response с текущими фильтрами. Они не получают account IDs, recovery data,
session tokens или другие credentials.

### Модерация

Статусы в UI дополнительно переводятся:

```text
open       -> Новое
reviewing  -> В работе
resolved   -> Закрыто
dismissed  -> Отклонено
```

Очередь поддерживает `open`, `reviewing`, `resolved`, `dismissed`, `all`. Каждое дело можно открыть
как отдельный workspace и проверить:

- current name и account ID;
- independent reporters / total reports / reasons;
- immutable evidence rows;
- name snapshot и chapter snapshot на момент accepted report;
- полную moderation history;
- moderator identity для действий, выполненных через Control Plane.

Причины жалоб также показываются понятными подписями (`AFK`, griefing, offensive name,
exploit/cheat).

`owner` и `moderator` могут переводить дело между статусами. `resolved` и `dismissed` требуют note.
Интерфейс делает изменение двухшаговым: первый tap только готовит действие, второй в течение 10
секунд подтверждает тот же status/note.

Для каждого detail-response сервер возвращает `revision`, построенный из последних immutable evidence
и moderation-event IDs. Во время transition сервер берёт SQLite write lock, повторно читает case и
сверяет этот revision **внутри той же transaction**, в которой затем пишет решение. Поэтому новая
жалоба не теряется даже при совпавшем millisecond timestamp, а цепочка переходов вроде
`open → reviewing → open` всё равно меняет revision. При несовпадении сервер отвечает
`case-changed`, ничего не применяет и возвращает свежий case для повторного review.

Control Plane **не** банит, не suspend-ит и не делает forced rename. Status `resolved` означает только,
что moderation review закрыт согласно note и реально выполненным внешним действиям. Не пишите в note
о наказании, которого система фактически не выполнила.

CLI `server/moderationCli.mjs` остаётся поддерживаемым fallback и локальным инструментом оператора.

### Журнал действий

В интерфейсе это называется **Журнал действий**, а не только техническим словом Audit.

Он показывает последние admin events: actor, role, понятное название action, target и timestamp.
Access code и session token в audit не записываются. Большие structured details заменяются валидным
JSON-marker о truncation, поэтому одна слишком большая запись не может сломать просмотр всего
журнала.

Для moderation transition в admin audit сохраняются только transition metadata и `notePresent`; сама
moderator note уже находится в `moderation_events` и намеренно не дублируется во второй журнал.

## Отключение панели при инциденте

Самый быстрый способ закрыть HTTP admin API:

```bash
sed -i 's/^ADMIN_PANEL_ENABLED=.*/ADMIN_PANEL_ENABLED=0/' /etc/wobble.env
systemctl restart wobble
```

После этого `/api/admin/*` отвечает как отсутствующий endpoint. Admin tables и audit history остаются
в базе; повторное включение не требует новой миграции.

Если скомпрометирован конкретный access code, предпочтительнее `rotate` или `disable`, а не удаление
строк SQLite вручную.

## Следующие этапы

План развития Control Plane:

1. ~~moderation case detail + безопасные status transitions~~;
2. ~~analytics charts, фильтры, сравнение периодов и export~~;
3. player/account support view без раскрытия credentials;
4. privileged operations helper для backup/smoke/restart и позже deploy;
5. system status: Nginx, certificate, disk, listeners и backup/offsite;
6. confirmations, operation queue и расширенный audit для опасных действий.

Каждый этап должен идти отдельным PR с review и CI.
