# Руководство модератора Wobble Rush

Точный data model описан в [`MODERATION.md`](MODERATION.md). Этот документ — практический SOP.

## 1. Основной принцип

Жалоба — сигнал для human review, а не автоматическое наказание.

Текущий moderation tool:

- работает локально на VPS;
- читает production SQLite;
- не имеет public HTTP endpoint;
- не банит, не suspend-ит и не переименовывает игрока автоматически;
- сохраняет audit trail решений.

## 2. Причины жалоб

Разрешены только:

```text
afk
griefing
offensive-name
exploit-cheat
```

Free-text reason игрок не отправляет.

## 3. Статусы case

```text
open
reviewing
resolved
dismissed
```

`resolved` и `dismissed` требуют note.

Если после закрытия приходит более новая accepted report, effective status снова становится `open`,
но предыдущая moderation history сохраняется.

## 4. Запуск CLI

Production DB:

```text
/var/lib/wobble/leaderboard.db
```

CLI запускайте как Linux-user `wobble`:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db queue
```

CLI специально отказывается создавать новую БД при ошибке в пути.

## 5. Очередь

Открытые cases:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db queue
```

Under review:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db queue \
  --status reviewing
```

Все статусы:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db queue \
  --status all \
  --limit 100
```

Queue сортируется для triage: independent reporters важнее общего количества повторов, затем
учитываются cheat/offensive-name signals и свежесть. Это порядок проверки, не verdict.

## 6. Изучить case

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db show <account-id>
```

Проверьте:

- current name;
- unique reporters;
- total reports;
- reasons;
- immutable evidence rows;
- name snapshot на момент report;
- chapter snapshot;
- previous moderation history;
- timestamps.

Особенно для `offensive-name` смотрите snapshot: текущий nickname мог уже измениться.

## 7. Взять case в работу

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db set <account-id> reviewing \
  --moderator malik
```

Используйте стабильный moderator ID, чтобы audit trail оставался читаемым.

## 8. Закрыть

Resolved:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db set <account-id> resolved \
  --moderator malik \
  --note "Reviewed evidence; moderation response completed."
```

Dismissed:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db set <account-id> dismissed \
  --moderator malik \
  --note "Evidence reviewed; no moderation action justified."
```

Note должна описывать проверку/результат, а не содержать credentials или лишние персональные данные.

## 9. Рекомендуемый SOP

```text
queue
  -> show
  -> проверить independent reporters и evidence
  -> set reviewing
  -> выполнить внешнее действие, если оно существует
  -> resolved/dismissed + понятная note
```

Не пишите в note, что игрок "забанен", если такого действия фактически не было.

## 10. Запрещённые практики

Не делайте:

- ban через ручное удаление account/session rows;
- forced rename через случайный SQL;
- verdict только по числу reports;
- публикацию moderation SQLite через Nginx;
- запись recovery code, cookie, IP или другого credential в note;
- массовый export evidence без необходимости.

Если CLI сообщает кратковременный SQLite lock, подождите и повторите. Не копируйте live DB ради
обычного review.

## 11. Checklist закрытия

```text
[ ] account ID проверен
[ ] evidence прочитано
[ ] independent reporters учтены
[ ] snapshots проверены
[ ] case был reviewing, если шло расследование
[ ] решение не основано только на report count
[ ] note не содержит secrets
[ ] note соответствует реально выполненному действию
```
