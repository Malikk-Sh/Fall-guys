# Wobble Rush Control Plane

## Назначение

`/admin/` — отдельная интерактивная панель владельца проекта, операторов, модераторов и аналитиков.
Она не использует игровой recovery code и не повышает обычный аккаунт игрока до администратора.

Control Plane показывает production health, build/release identity, нагрузку, аккаунты, gameplay
metrics, moderation workflow и admin audit history. Системные действия уровня backup/restart/deploy
будут подключаться отдельными PR поверх этой границы безопасности.

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

| Role        | Текущие возможности                                               |
| ----------- | ----------------------------------------------------------------- |
| `owner`     | все read views, moderation writes, будущие admin/ops capabilities |
| `operator`  | dashboard, analytics, moderation read, audit                      |
| `moderator` | dashboard, moderation case review и безопасные status transitions |
| `analyst`   | dashboard и gameplay analytics                                    |
| `viewer`    | только dashboard                                                  |

Capabilities проверяет `server/adminAuth.js`; frontend лишь отражает результат сервера.

## Bootstrap первого owner

После deploy migration 011 создаст таблицы, но **не создаст администратора автоматически**.

На VPS:

```bash
sudo -u wobble node /opt/wobble/server/adminCli.mjs \
  --db /var/lib/wobble/leaderboard.db \
  create --name Malik --role owner
```

Команда вернёт JSON с `user` и `accessCode`. `accessCode` показывается один раз. Сохраните его в
password manager и не отправляйте в Issues, PR, логи или moderator notes.

После этого включите панель в `/etc/wobble.env`:

```dotenv
ADMIN_PANEL_ENABLED=1
ADMIN_COOKIE_SECURE=1
```

и перезапустите только Wobble:

```bash
systemctl restart wobble
curl -fsS http://127.0.0.1:3000/health/live
```

Панель:

```text
https://wobbles.ru/admin/
```

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

## Что видно в панели сейчас

### Overview

- package version / commit / release;
- protocol version;
- uptime;
- rooms / players;
- event-loop p95, RSS и heap;
- socket/match capacity;
- matchmaking waiting;
- total accounts и accounts with active persistent sessions in the last 24h;
- open/reviewing moderation queue;
- report evidence count за 24 часа;
- competitive leaderboard entry count;
- backup health из production `/health` model.

### Analytics

Read-only представление `GameplayMetrics.summary()` с выбором 1/7/30/90 дней. Семантика полей
остаётся той же, что описана в [`ANALYTICS.md`](ANALYTICS.md).

### Moderation

Очередь поддерживает `open`, `reviewing`, `resolved`, `dismissed`, `all`. Каждое дело можно открыть
как отдельный workspace и проверить:

- current name и account ID;
- independent reporters / total reports / reasons;
- immutable evidence rows;
- name snapshot и chapter snapshot на момент accepted report;
- полную moderation history;
- moderator identity для действий, выполненных через Control Plane.

`owner` и `moderator` могут переводить дело между статусами. `resolved` и `dismissed` требуют note.
Интерфейс делает изменение двухшаговым: первый tap только готовит действие, второй в течение 10
секунд подтверждает тот же status/note.

Дополнительно сервер использует optimistic guard. При открытии case браузер запоминает current status
и `lastReportedAt`. Если до подтверждения пришла новая жалоба или другой moderator изменил дело,
сервер отвечает `case-changed`, не применяет старое решение и возвращает свежий case для повторного
review. Так новая evidence не может случайно попасть под решение, принятое до того, как moderator её
увидел.

Control Plane **не** банит, не suspend-ит и не делает forced rename. Status `resolved` означает только,
что moderation review закрыт согласно note и реально выполненным внешним действиям. Не пишите в note
о наказании, которого система фактически не выполнила.

После успешного transition панель обновляет и открытую карточку, и текущую очередь, поэтому дело
сразу исчезает из старого status-фильтра, если больше ему не соответствует.

CLI `server/moderationCli.mjs` остаётся поддерживаемым fallback и локальным инструментом оператора.

### Audit

Последние admin events: actor, role, action, target и timestamp. Access code и session token в audit
не записываются. Большие structured details заменяются валидным JSON-marker о truncation, поэтому
одна слишком большая запись не может сломать просмотр всего журнала.

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
2. полноценные analytics charts, фильтры и export;
3. player/account support view без раскрытия credentials;
4. privileged operations helper для backup/smoke/restart и позже deploy;
5. system status: Nginx, certificate, disk, listeners и backup/offsite;
6. confirmations, operation queue и расширенный audit для опасных действий.

Каждый этап должен идти отдельным PR с review и CI.
