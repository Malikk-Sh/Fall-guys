# Руководство модератора Wobble Rush

Точный data model описан в [`MODERATION.md`](MODERATION.md). Этот документ — практический SOP.

## 1. Основной принцип

Жалоба — сигнал для human review, а не автоматическое наказание.

Если Wobble Control Plane включён, основной интерфейс модератора:

```text
https://wobbles.ru/admin/
```

Он показывает очередь, immutable evidence, snapshots и историю решений и позволяет `owner` /
`moderator` безопасно менять status. Локальный `moderationCli.mjs` остаётся fallback-инструментом
оператора VPS.

Ни панель, ни CLI сейчас:

- не банят;
- не suspend-ят;
- не делают forced rename;
- не считают число reports автоматическим verdict.

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

## 4. Работа через Control Plane

Откройте вкладку **Модерация**, выберите статус очереди и нажмите **Открыть** у нужного case.

Карточка дела показывает:

- current name и account ID;
- unique reporters;
- total reports;
- reasons;
- immutable evidence rows;
- name snapshot на момент accepted report;
- chapter snapshot;
- previous moderation history;
- timestamps и moderator identity.

Особенно для `offensive-name` смотрите snapshot: текущий nickname мог уже измениться.

### Взять дело в работу

Выберите `reviewing`. Первое нажатие **Подготовить изменение** ничего не записывает: UI покажет
второе подтверждение. Проверьте case ещё раз и подтвердите в течение 10 секунд.

### Закрыть дело

Для `resolved` или `dismissed` обязательно заполните note. Note должна объяснять результат review и
реально выполненное действие, но не содержать credentials или лишние персональные данные.

Если между открытием дела и подтверждением пришла новая accepted report или другой moderator изменил
status, сервер отклонит stale decision и вернёт свежую карточку. Прочитайте новые данные и принимайте
решение заново.

Каждый transition пишется одновременно в moderation history и admin audit. Если audit event сохранить
не удалось, status тоже не меняется.

## 5. CLI fallback

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

## 6. Изучить case через CLI

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db show <account-id>
```

Проверьте те же данные, что и в Control Plane: evidence, snapshots, reporters, reasons и history.

## 7. Изменить status через CLI

Взять в работу:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db set <account-id> reviewing \
  --moderator malik
```

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

Для CLI используйте стабильный moderator ID, чтобы history оставалась читаемой.

## 8. Рекомендуемый SOP

```text
queue
  -> открыть case
  -> проверить independent reporters и immutable evidence
  -> reviewing
  -> выполнить внешнее действие, если оно действительно существует
  -> resolved/dismissed + понятная note
```

Не пишите в note, что игрок "забанен", если такого действия фактически не было.

## 9. Запрещённые практики

Не делайте:

- ban через ручное удаление account/session rows;
- forced rename через случайный SQL;
- verdict только по числу reports;
- публикацию moderation SQLite через Nginx;
- запись recovery code, cookie, IP или другого credential в note;
- массовый export evidence без необходимости.

Если CLI сообщает кратковременный SQLite lock, подождите и повторите. Не копируйте live DB ради
обычного review.

## 10. Checklist закрытия

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
