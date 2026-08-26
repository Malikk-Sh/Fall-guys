# Аналитика и статистика Wobble Rush

## 1. Назначение

Gameplay analytics отвечает на вопросы уровня игры и баланса без individual user tracking:

- где чаще падают;
- где бросают матч;
- какая глава хуже проходит;
- чем отличаются mobile и desktop;
- как меняется verified finish time;
- превращает ли race knockdown удар в короткий весёлый хаос или в серию повторных ударов и падение.

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
knockdown_started
knockdown_recovered
knockdown_then_fall
knockdown_repeat_hit
finish_rejected
sustained_speed_peak
sustained_speed_path_at_peak
sustained_speed_net_at_peak
```

`finish_rejected` считает отказы в финише, `detail` — причину: `checkpoint-missing` (сервер не
засчитал арку, которую засчитал клиент) или `finish-validation` (последнее состояние до ленты не
дошло). Первая причина означает расхождение моделей чекпоинта, а не сетевую задержку, и её рост —
повод смотреть на трассу, а не на канал.

`sustained_speed_peak`, `sustained_speed_path_at_peak` и `sustained_speed_net_at_peak` — три меры
ОДНОЙ величины на одном и том же двухсекундном окне, записанные в сотых долях (делите
`total / samples` на 100). Мер три, потому что решающая величина завышает по двум независимым
причинам, и по одной паре их не различить:

- `peak` — среднее по пакетам **без веса**. Ровно оно принимает решение о признаке
  `sustained-speed`. Короткий быстрый промежуток входит в него с тем же весом, что и длинный
  медленный: на прямой при промежутках 33 и 132 мс это даёт 12.5 против настоящих 8.0.
- `path` — длина пути за то же окно, делённая на реально прошедшее время. Вес по времени, кривизна
  учтена. Разница с `peak` — ровно цена отсутствия веса.
- `net` — прямая между концами окна за то же время; так считает кооператив. Разница с `path` —
  ровно кривизна пути.

Читается так: `peak` заметно выше `path` — виновата формула, и виновата неравномерностью прихода
пакетов; `path` заметно выше `net` — игрок вилял; все три близки — игрок действительно ехал быстро,
и разговор про порог, а не про формулу.

`detail` — `когорта:состояние`, где когорта отделяет забеги, в которых признак сработал (`noted`),
израсходовал запас (`over`) и не срабатывал вовсе (`quiet`). Без этого деления среднее считалось бы
по всему населению, где спокойных забегов заведомо больше, и они размыли бы ровно те значения, ради
которых замер сделан: сшить эти строки с `movement_anomaly` нельзя — `GameplayMetrics` хранит только
суммы по ключу измерений. Только гонка: у кооператива своя проверка, уже считающая смещением.

Если peak-окно содержит хотя бы один достоверный интервал `knockdown`, к `detail` добавляется
компактный suffix `kd-TPC`, например `over:knockdown:kd-23u`. Он специально помещается вместе с
префиксом в 32-символьный предел `GameplayMetrics`:

- `T` — доля времени полного peak-окна в стабильном `knockdown`: `1` = (0, 25 %], `2` =
  (25 %, 50 %], `3` = (50 %, 75 %], `4` = (75 %, 100 %];
- `P` — доля длины пути полного peak-окна в стабильном `knockdown`, с теми же четырьмя корзинами;
- `C` — скорость пути на стабильных интервалах вне `knockdown`: `u` = не выше текущего порога,
  `o` = выше, `n` = таких интервалов нет.

Интервал, у которого состояния на двух концах различаются, не приписывается целиком ни старому, ни
новому состоянию: точный момент перехода внутри сетевого промежутка неизвестен. Такой интервал
исключается и из knockdown-числителя, и из расчёта `C`, а знаменатели `T`/`P` остаются полным окном и
полным путём. Поэтому эти доли консервативны и не превращают редкий пакет на границе состояния в
ложное доказательство причинности. Suffix остаётся только диагностикой и не меняет anti-cheat решение.

`device` имеет грубые категории `mobile` и `desktop`. Это инструмент сравнения touch/mobile против
desktop, а не детектор конкретной модели устройства.

Для `finish_time`:

- `samples` — число результатов;
- `total` — сумма millisecond values внутри SQLite;
- API возвращает `average`;
- `detail` разделяет `verified` и `unverified`.

Не смешивайте verified и unverified время в одном среднем.

### Race knockdown

Новый race knockdown не смешивается со старым co-op `playerDowned`. Это разные механики и разные
состояния.

- `knockdown_started` — сервер принял переход игрока в `state=knockdown`;
- `knockdown_recovered` — сервер принял обычный выход из `knockdown`; `average` — сколько миллисекунд
  прошло от начала сбивания до восстановления;
- `knockdown_then_fall` — после knockdown сервер обработал настоящий respawn не позднее чем через
  3 секунды; `average` — время от начала knockdown до respawn;
- `knockdown_repeat_hit` — пока игрок уже лежал, между двумя принятыми сервером состояниями появился
  новый сильный импульс, характерный для повторного удара препятствия.

Для этих метрик `detail` — тип процедурного участка, определённый сервером по принятой позиции:
например `bumpers`, `sweepers`, `punchers`. Это bounded набор из каталога сегментов, а не ID объекта
или координаты.

`knockdown_started`, `knockdown_recovered` и факт respawn опираются на состояние, уже прошедшее
обычную серверную проверку, и серверный timestamp respawn. `knockdown_repeat_hit` — продуктовая
эвристика по скачку скорости: она нужна для баланса, но не является доказательством конкретной
коллизии. Ни одна knockdown-метрика не участвует в физике, выдаче наград, проверке результата или
таблице рекордов.

## 3. Retention и cardinality

Gameplay metrics хранятся 90 дней.

События сначала буферизуются в памяти и flush-ятся пачкой в SQLite. Есть bounded key cardinality.
Если API показывает `dropped > 0`, разработчик должен проверить instrumentation: это обычно
признак слишком большого числа уникальных dimension values.

Нельзя добавлять account ID, session ID, timestamp или другой уникальный identifier в `detail`.

## 4. Read-only SQL

Приложение использует встроенный `node:sqlite`, поэтому Wobble installer не обязан устанавливать
отдельный shell-клиент `sqlite3`. Если вы хотите выполнять SQL-рецепты из этого раздела прямо на
Ubuntu/Debian VPS, один раз установите CLI:

```bash
sudo apt-get update
sudo apt-get install -y sqlite3
```

После этого открывайте production DB только read-only:

```bash
sqlite3 -readonly /var/lib/wobble/leaderboard.db
```

### События за 7 дней

`detail` включён в группировку намеренно: иначе `finish_time` смешал бы `verified` и `unverified`
результаты в одно вводящее в заблуждение среднее.

```sql
SELECT
  metric,
  detail,
  SUM(samples) AS samples,
  CASE
    WHEN SUM(total) <> 0
    THEN ROUND(1.0 * SUM(total) / SUM(samples))
    ELSE NULL
  END AS average
FROM gameplay_metrics
WHERE day >= date('now', '-6 day')
GROUP BY metric, detail
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

### Knockdown по препятствиям

```sql
SELECT
  metric,
  course,
  detail AS obstacle_segment,
  device,
  SUM(samples) AS samples,
  CASE
    WHEN SUM(total) <> 0
    THEN ROUND(1.0 * SUM(total) / SUM(samples))
    ELSE NULL
  END AS average_ms
FROM gameplay_metrics
WHERE day >= date('now', '-6 day')
  AND mode = 'race'
  AND metric IN (
    'knockdown_started',
    'knockdown_recovered',
    'knockdown_then_fall',
    'knockdown_repeat_hit'
  )
GROUP BY metric, course, detail, device
ORDER BY metric, samples DESC;
```

Для первого решения по балансу смотрите как минимум на `started`, долю `then_fall`, число
`repeat_hit` на одно начало и среднее время восстановления. Всегда сравнивайте mobile и desktop
отдельно и показывайте sample count.

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

Приблизительно active authenticated accounts за 24 часа лучше считать по активности persistent
sessions: обычный возврат через HttpOnly cookie обновляет `account_sessions.last_seen_at`, а не
`accounts.last_seen_at`.

```sql
SELECT COUNT(DISTINCT account_id) AS active_accounts_24h
FROM account_sessions
WHERE last_seen_at >=
    (CAST(strftime('%s', 'now') AS INTEGER) - 86400) * 1000
  AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000;
```

Это operational approximation активности аутентифицированных аккаунтов, а не полноценный event
analytics DAU: таблица sessions описывает auth activity, а не каждое gameplay event.

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
4. Knockdown: starts / recovery / then-fall / repeat hits по obstacle segment и device
5. Top abandon checkpoints
6. Verified average finish time
7. Доля unverified finish
8. Mobile vs desktop
9. dropped metric keys
10. Technical health и restarts
11. Moderation open/reviewing cases
12. Выводы
13. Что изменить
14. Что измерить после следующего release
```

Всегда показывайте sample count. Корреляцию не называйте причиной без дополнительного
эксперимента или проверки.
