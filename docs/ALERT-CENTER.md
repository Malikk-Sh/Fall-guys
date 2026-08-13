# Wobble Control — Alert Center

## Зачем он нужен

Reliability Center и раздел «Сервер» уже умеют показать, **что происходило**, а Durable Operations — безопасно выполнить ограниченный набор действий. До этого PR оператор всё равно должен был сам открыть панель в нужный момент и заметить ухудшение.

Alert Center добавляет независимый слой **«что требует внимания сейчас»**. Он не заменяет исходную диагностику и не выполняет автоматический restart.

## Источники

Alert evaluator работает внутри независимого `wobble-control.service` и использует только уже существующие безопасные источники:

- `ControlPlaneInfrastructure.snapshot()`;
- read-only `ServiceReliabilityReader.report()`;
- локальный `AdminOperationsClient.status()`.

Он не читает raw `journalctl`, WebSocket payload, HTTP body, player/account IDs, IP или User-Agent.

## Правила первой версии

Закрытый allowlist правил:

- игровой процесс недоступен вне штатного graceful restart;
- игровой процесс отвечает, но не ready;
- `nginx.service` не активен;
- production HTTPS/SNI недоступен;
- TLS недоверенный / просроченный;
- TLS истекает не позже чем через 14 дней;
- обязательный local/offsite backup устарел или недоступен;
- диск production DB занят на 85%+ (`warning`) или 95%+ (`critical`);
- Reliability Center вернул `warning`/`critical`;
- Durable Operation не меняла состояние больше пяти минут.

Во время активного `wobble.restart` evaluator **не создаёт ложный alert о временной недоступности игры**, но продолжает проверять диск, backup, TLS, Nginx и Reliability.

## Debounce / recovery

Один неудачный probe не открывает incident.

По умолчанию:

```text
interval = 60 секунд
open after = 2 последовательных плохих наблюдения
resolve after = 2 последовательных здоровых наблюдения
```

Если источник сам временно недоступен, Alert Center не считает это доказательством восстановления и не закрывает существующий alert.

## Durable state

Состояние хранится отдельно от gameplay SQLite:

```text
/var/lib/wobble-control/alerts.json
```

Каталог создаётся systemd через `StateDirectory=wobble-control`; файл пишет только `wobble-control.service`. Запись атомарная (`temp → fsync → rename → fsync directory`) и bounded до 100 alert incidents.

В state нет credential/token/recovery/player data. Записываются только:

- UUID alert incident;
- allowlisted rule;
- severity/state;
- timestamps;
- acknowledgement admin display name/role;
- маленький allowlisted context из boolean/number/reason-code полей.

Новая SQLite migration не нужна, и gameplay process остаётся единственным владельцем gameplay schema migrations.

## Acknowledge — не Resolve

Owner/operator может нажать **«Отметить как увиденное»**. Это только фиксирует, что человек увидел текущий incident.

Acknowledgement:

- не скрывает проблему;
- не меняет источник health;
- не запускает Operations;
- не помечает alert resolved;
- записывается в admin audit.

Resolved появляется только после устойчивого восстановления исходного сигнала.

## Failure isolation

Alerting — observability/workflow слой.

- Ошибка одного source probe не должна завершать Control Plane.
- Ошибка evaluator не меняет gameplay/API semantics.
- Alert Center не получает root-доступ.
- Он не вызывает `wobble-ops` actions автоматически.
- Он не делает внешних webhook/Telegram запросов.

Последний пункт намеренный: сначала нужен корректный локальный incident lifecycle. Внешние уведомления можно добавить отдельным PR с отдельным secret/egress boundary, не смешивая их с детектированием.

## UI

Вкладка **«Оповещения»** доступна owner/operator и показывает:

- число active critical/warning;
- unacknowledged count;
- freshness evaluator;
- текущие incidents с рекомендуемым разделом для диагностики;
- acknowledgement;
- последние resolved incidents.

Пока админская сессия открыта, клиент периодически читает только cached Alert Center status, поэтому badge обновляется без повторного запуска systemd/TLS/backup probes из браузера.
