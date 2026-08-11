# Аналитика и статистика Wobble Rush

## 1. Назначение

Gameplay analytics отвечает на вопросы уровня игры и баланса без individual user tracking:

- где чаще падают;
- где бросают матч;
- какая глава хуже проходит;
- чем отличаются mobile и desktop;
- как меняется verified finish time.

Основной endpoint:

```text
GET /metrics/gameplay?days=7&limit=200
```

Nginx не публикует `/metrics/` наружу.

На VPS:

```bash
curl -s 'http://127.0.0.1:3000/metrics/gameplay?days=7&limit=200' \
  | python3 -m json.tool
```

## 2. Модель данных

События агрегируются по измерениям:

```text
metric
mode
course
detail
device
```

Основные metric names:

```text
match_started
match_finished
match_abandoned
fall
finish_time
```

`device` имеет грубые категории `mobile` и `desktop`. Это инструмент сравнения touch/mobile против
desktop, а не детектор конкретной модели устройства.

Для `finish_time`:

- `samples` — число результатов;
- `total` — сумма millisecond values внутри SQLite;
- API возвращает `average`;
- `detail` разделяет `verified` и `unverified`.

Не смешивайте verified и unverified время в одном среднем.

## 3. Retention и cardinality

Gameplay metrics хранятся 90 дней.

События сначала буферизуются в памяти и flush-ятся пачкой в SQLite. Есть bounded key cardinality.
Если API показывает `dropped > 0`, разработчик должен проверить instrumentation: это обычно
признак слишком большого числа уникальных dimension values.

Нельзя добавлять account ID, session ID, timestamp или другой уникальный identifier в `detail`.

## 4. Read-only SQL

Для production-аналитики используйте:

```bash
sqlite3 -readonly /var/lib/wobble/leaderboard.db
```

### События за 7 дней

```sql
SELECT
  metric,
  SUM(samples) AS samples,
  CASE
    WHEN SUM(total) <> 0
    THEN ROUND(1.0 * SUM(total) / SUM(samples))
    ELSE NULL
  END AS average
FROM gameplay_metrics
WHERE day >= date('now', '-6 day')
GROUP BY metric
ORDER BY samples DESC;
```

### Самые частые падения

```sql
SELECT
  mode,
  course,
  detail,
  device,
  SUM(samples) AS falls
FROM gameplay_metrics
WHERE day >= date('now', '-6 day')
  AND metric = 'fall'
GROUP BY mode, course, detail, device
ORDER BY falls DESC
LIMIT 40;
```

### Где бросают матч

```sql
SELECT
  mode,
  course,
  detail,
  device,
  SUM(samples) AS abandons
FROM gameplay_metrics
WHERE day >= date('now', '-6 day')
  AND metric = 'match_abandoned'
GROUP BY mode, course, detail, device
ORDER BY abandons DESC
LIMIT 40;
```

### Completion rate

```sql
WITH x AS (
  SELECT
    mode,
    course,
    device,
    SUM(CASE WHEN metric = 'match_started' THEN samples ELSE 0 END) AS started,
    SUM(CASE WHEN metric = 'match_finished' THEN samples ELSE 0 END) AS finished
  FROM gameplay_metrics
  WHERE day >= date('now', '-6 day')
  GROUP BY mode, course, device
)
SELECT
  mode,
  course,
  device,
  started,
  finished,
  ROUND(100.0 * finished / NULLIF(started, 0), 1) AS finish_percent
FROM x
WHERE started > 0
ORDER BY finish_percent ASC, started DESC;
```

Это операционная оценка completion, а не доказательство причин, почему игроки ушли.

### Verified average finish time

```sql
SELECT
  mode,
  course,
  device,
  SUM(samples) AS finishes,
  ROUND(1.0 * SUM(total) / SUM(samples)) AS avg_ms
FROM gameplay_metrics
WHERE day >= date('now', '-6 day')
  AND metric = 'finish_time'
  AND detail = 'verified'
GROUP BY mode, course, device
ORDER BY avg_ms;
```

### Mobile vs desktop

```sql
SELECT
  device,
  metric,
  SUM(samples) AS samples
FROM gameplay_metrics
WHERE day >= date('now', '-6 day')
GROUP BY device, metric
ORDER BY metric, device;
```

## 5. Accounts как operational statistics

Количество аккаунтов:

```sql
SELECT COUNT(*) AS accounts
FROM accounts;
```

Новые аккаунты по дням:

```sql
SELECT
  date(created_at / 1000, 'unixepoch') AS day,
  COUNT(*) AS new_accounts
FROM accounts
GROUP BY day
ORDER BY day DESC
LIMIT 30;
```

Приблизительно active accounts за 24 часа:

```sql
SELECT COUNT(*) AS active_accounts_24h
FROM accounts
WHERE last_seen_at >=
  (CAST(strftime('%s', 'now') AS INTEGER) - 86400) * 1000;
```

`last_seen_at` не является полноценным event analytics session marker, поэтому не называйте этот
запрос строгим DAU без дополнительной продуктовой спецификации.

## 6. Что текущая analytics schema не умеет

Из `gameplay_metrics` нельзя надежно получить:

- cohort retention по individual users;
- user-level funnel;
- individual journey;
- LTV;
- уникальных игроков по event stream.

Это намеренное privacy/complexity ограничение. Если понадобится такая аналитика, сначала нужно
спроектировать отдельную privacy-aware schema, а не протащить account ID в существующие dimensions.

## 7. Недельный отчёт

Рекомендуемый шаблон:

```text
Период:
Release / build:

1. Starts / finishes
2. Completion rate по mode/course/device
3. Top fall hotspots
4. Top abandon checkpoints
5. Verified average finish time
6. Доля unverified finish
7. Mobile vs desktop
8. dropped metric keys
9. Technical health и restarts
10. Moderation open/reviewing cases
11. Выводы
12. Что изменить
13. Что измерить после следующего release
```

Всегда показывайте sample count. Корреляцию не называйте причиной без дополнительного
эксперимента или проверки.
