# Wobble Control — Reliability Center

## Назначение

Вкладка **«Надёжность»** показывает историю состояния всего production-сервера. Она дополняет Incident Center: «Инциденты» отвечают на вопрос, что происходило с конкретным игроком, а Reliability Center помогает понять, был ли в тот же момент общий серверный сбой, перегрузка, проблема reconnect или перезапуск процесса.

Это не веб-интерфейс к `journalctl` и не просмотр raw logs. Панель получает только заранее определённую безопасную telemetry.

## Доступ

Capability:

```text
reliability.read
```

Её имеют только роли:

```text
owner
operator
```

`moderator`, `analyst` и `viewer` не получают серверную operational history.

## Что сохраняется

Раз в минуту сохраняется bounded snapshot:

- event-loop p95;
- RSS и heap текущего Node-процесса;
- количество WebSocket;
- количество активных матчей;
- количество ожидающих matchmaking;
- delta успешных и неудачных reconnect;
- delta handler errors;
- delta WebSocket send failures;
- delta capacity rejects;
- delta snapshots, пропущенных защитой от нагрузки;
- package version, commit и release tag.

Кумулятивные process counters превращаются в **delta до записи**. Поэтому один и тот же `resumeSucceeded=100` не суммируется повторно каждую минуту, а после рестарта новый процесс сначала устанавливает baseline с нулевой delta.

Для длинных периодов API агрегирует minute samples:

| Период  | Шаг ответа |
| ------- | ---------- |
| 1 час   | 1 минута   |
| 6 часов | 5 минут    |
| 24 часа | 15 минут   |
| 7 дней  | 1 час      |
| 30 дней | 6 часов    |

Так объём ответа панели остаётся ограниченным.

## Группы ошибок

Сервер уже пишет structured JSON events в journald. Reliability Capture перехватывает только закрытый allowlist operational events и пропускает исходную запись дальше в console/journald без изменений.

Для ошибки в SQLite попадают только:

- безопасное имя события;
- severity;
- timestamp;
- build identity;
- необратимый SHA-256 fingerprint;
- счётчик occurrences.

Одинаковые события в пределах minute bucket группируются, затем в отчёте дополнительно объединяются по event + severity + fingerprint + build.

Fingerprint вычисляется локально из нормализованного error context. Исходный message/stack после вычисления в Reliability storage не передаётся.

## Privacy boundary

В `service_reliability_samples`, `service_reliability_events`, API и диагностический JSON **не сохраняются и не возвращаются**:

- Account ID или Support ID;
- player ID;
- room code или match ID;
- IP-адрес;
- raw User-Agent;
- device fingerprint;
- session/access/reconnect/socket tokens;
- recovery data;
- WebSocket payload;
- HTTP request body;
- raw exception message;
- stack trace;
- произвольный клиентский текст.

Если structured log содержит такие поля, capture использует только allowlisted event/severity/time и локально вычисленный fingerprint. Остальные поля отбрасываются.

## Retention и bounds

По умолчанию:

```text
retention = 30 дней
max service_reliability_events rows = 20 000
```

Старые samples/events удаляются bounded housekeeping. Event table дополнительно ограничивается количеством строк, чтобы всплеск ошибок не мог бесконечно увеличивать production DB.

Reliability telemetry агрегирована и не содержит player identifiers, поэтому в отличие от `player_incident_events` она может оставаться в обычных verified backups. Это позволяет восстановить operational history вместе с production DB.

## Failure isolation

Reliability — только observability. Ошибка telemetry не должна менять игровой протокол, auth, moderation или завершать процесс.

- capture всегда сначала вызывает оригинальный `console.log` / `console.error`;
- ошибки parsing/fingerprint/storage поглощаются на границе telemetry;
- до готовности SQLite sink используется маленькая bounded in-memory очередь;
- minute sampler выполняется best-effort;
- финальный sample при штатном выключении также best-effort.

Operational error events редкие и записываются отдельно от высокочастотного игрового потока; PLAYER_STATE/snapshot packets не создают reliability rows.

## Статус

Reliability Center рассчитывает статус только как операторскую подсказку, а не как автоматическое решение о рестарте.

Примеры warning/critical сигналов:

- внутренние handler errors;
- event-loop p95 выше допустимого уровня;
- высокая доля reconnect failures при достаточном количестве попыток;
- повторяющиеся socket send failures;
- capacity rejects;
- lifecycle event с warning/error severity.

Панель ничего не перезапускает автоматически.

## Safe Diagnostic Bundle

Кнопка **«Скопировать диагностику»** создаёт JSON только из уже разрешённого ответа Reliability API:

- период и время формирования;
- build identity;
- общий status/reasons;
- агрегированный summary;
- error groups;
- lifecycle;
- агрегированный time series.

Bundle намеренно не содержит raw logs и player data. Его можно приложить к техническому разбору без ручного копирования `journalctl`.

## Что остаётся в journald

Полный structured server log остаётся только в штатном production logging (`journalctl -u wobble`). Если fingerprint показывает повторяющуюся неизвестную проблему и агрегата недостаточно, инженер может сопоставить время/build/fingerprint с journald через SSH согласно `INCIDENT-RUNBOOK.md`.

Reliability Center не заменяет forensic/debug logs; он сокращает время до понимания масштаба и типа проблемы и не расширяет удалённый доступ к чувствительным данным.
