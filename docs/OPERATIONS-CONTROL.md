# Wobble Control — безопасные системные операции

Этот документ описывает узкую privileged-границу, через которую вкладка **Операции** может запускать
несколько заранее определённых действий на production VPS.

## Главное правило

Игровой Node-процесс (`User=wobble`) **не запускает shell от root** и не получает универсальный `sudo`.
Он умеет только подключиться к закрытому Unix socket:

```text
/run/wobble-ops.sock
```

Socket принадлежит `root:wobble`, имеет mode `0660` и активирует root-owned helper:

```text
/usr/local/lib/wobble-ops/helper.mjs
```

Исходник helper копируется туда installer-ом с владельцем `root:root`. Root helper никогда не запускается
непосредственно из `/opt/wobble`, потому что этим каталогом владеет service-user игры.

## Разрешённые операции

| Action ID        | Что запускается                       | От чьего имени выполняется полезная работа |
| ---------------- | ------------------------------------- | ------------------------------------------ |
| `backup.create`  | `wobble-backup.service`               | `wobble`                                   |
| `backup.verify`  | `wobble-backup-verify.service`        | `wobble`                                   |
| `smoke.run`      | `wobble-smoke.service`                | `wobble`                                   |
| `wobble.restart` | restart `wobble.service`              | systemd; сама игра снова `User=wobble`     |

Никакой action не принимает имя systemd unit, путь, команду или аргументы от браузера. HTTP передаёт только
один из фиксированных action ID. Helper сам сопоставляет его с фиксированным unit.

## Что принципиально запрещено

В эту границу нельзя добавлять API вида:

```text
POST /api/admin/shell
POST /api/admin/systemctl { unit: "..." }
POST /api/admin/run { command: "..." }
```

Также нельзя подставлять значения HTTP request в `spawn`, `exec`, shell-строку или имя unit.

Если понадобится новая системная операция, она добавляется отдельным кодовым изменением:

1. отдельный фиксированный action ID;
2. конкретный systemd unit или фиксированная команда в root-owned helper;
3. минимальные права выполнения;
4. понятное описание влияния в UI;
5. regression test;
6. audit event;
7. review + CI.

## Защита от случайного запуска

UI требует два нажатия в течение 10 секунд. Сервер дополнительно требует поле `confirmation`, точно равное
выбранному action ID. Все endpoints требуют admin CSRF и capability `ops.execute`, которая сейчас есть только у
роли `owner`.

Для restart helper также держит cooldown, а синхронные операции выполняются по одной.

## Audit

Для системных действий используются события:

```text
ops.operation.requested
ops.operation.completed
ops.operation.accepted
ops.operation.failed
```

`requested` пишется до обращения к helper. Для restart `accepted` означает, что фиксированный restart уже
поставлен в очередь; это не выдаётся за доказательство успешного следующего старта процесса.

В audit не записывается raw stderr/systemctl output, чтобы случайно не протащить туда секреты или лишнюю
системную информацию.

## Проверка после deploy

```bash
systemctl status wobble-ops.socket --no-pager
ls -l /run/wobble-ops.sock
stat -c '%a %U:%G %n' /usr/local/lib/wobble-ops/helper.mjs
```

Ожидаемо:

```text
wobble-ops.socket: active (listening)
/run/wobble-ops.sock: root:wobble, srw-rw----
/usr/local/lib/wobble-ops/helper.mjs: 755 root:root
```

Сам `wobble-ops.service` может быть inactive до первого запроса: socket activation запустит его при обращении.
