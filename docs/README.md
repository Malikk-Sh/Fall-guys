# Документация Wobble Rush

Это центральная точка входа в техническую и эксплуатационную документацию проекта. Здесь собраны
ролевые руководства, а узкие документы рядом остаются источником истины для конкретных подсистем.

## Быстрый выбор по роли

- **Разработчик:** [`DEVELOPER.md`](DEVELOPER.md).
- **Владелец VPS / оператор:** [`OPERATIONS.md`](OPERATIONS.md).
- **Модератор:** [`MODERATOR-GUIDE.md`](MODERATOR-GUIDE.md).
- **Аналитик / статистик:** [`ANALYTICS.md`](ANALYTICS.md).
- **Дежурный по инциденту:** [`INCIDENT-RUNBOOK.md`](INCIDENT-RUNBOOK.md).
- **Нужна одна команда:** [`COMMANDS.md`](COMMANDS.md).

## Руководства

- [`DEVELOPER.md`](DEVELOPER.md) — архитектура, локальная разработка, Git/CI, протокол, миграции,
  server-authoritative границы и checklist для production-sensitive изменений.
- [`OPERATIONS.md`](OPERATIONS.md) — production layout, systemd, Nginx, shared TCP/443, UFW, TLS,
  deploy, релизы, backup/restore и ежедневная эксплуатация.
- [`ANALYTICS.md`](ANALYTICS.md) — семантика `/metrics/gameplay`, read-only SQL и шаблон регулярного
  продуктово-технического отчёта.
- [`MODERATOR-GUIDE.md`](MODERATOR-GUIDE.md) — практический SOP модератора поверх локальной
  moderation queue.
- [`INCIDENT-RUNBOOK.md`](INCIDENT-RUNBOOK.md) — пошаговая диагностика сайта, WebSocket, БД,
  backup, shared 443 и неудачного deploy.
- [`COMMANDS.md`](COMMANDS.md) — короткий справочник повседневных команд.

## Узкие документы — источник истины

Следующие документы уже описывают конкретные подсистемы подробнее. Новые ролевые руководства не
заменяют их, а связывают в единый рабочий процесс:

- [`DEPLOY.md`](DEPLOY.md) — установка и базовое развёртывание.
- [`../deploy/PRODUCTION-SAFETY.md`](../deploy/PRODUCTION-SAFETY.md) — verified backup, restore,
  deploy safety и shared-443 topology.
- [`MODERATION.md`](MODERATION.md) — data model и точная семантика moderation queue.
- [`ACCOUNT-SELF-SERVICE.md`](ACCOUNT-SELF-SERVICE.md) — active sessions, recovery rotation и logout.
- [`RELEASE-PROCESS.md`](RELEASE-PROCESS.md) — immutable tags, GitHub Release и exact-release deploy.

## Приоритет источников

Если документация расходится с исполняемым кодом, ориентируйтесь в таком порядке:

1. исполняемый код и схемы в `shared/`, `server/` и `deploy/`;
2. автоматические тесты и CI;
3. numbered migrations;
4. узкие документы выше;
5. ролевые руководства из этой папки.

После изменения поведения production-sensitive подсистемы обновляйте соответствующее руководство в
том же PR.

## Версии, которые нельзя путать

В проекте несколько независимых версий:

- package version — публичная версия приложения;
- `PROTOCOL_VERSION` — совместимость client/server WebSocket;
- schema migration version — состояние SQLite;
- leaderboard verification version — уровень проверки competitive records.

Каждая версия решает свою задачу; нельзя использовать одну как замену другой.
