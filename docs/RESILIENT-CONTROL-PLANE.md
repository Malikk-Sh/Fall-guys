# PR #78 — Resilient Control Plane

Status: design contract for `feat/resilient-control-plane`.

## Problem

Wobble Control currently runs inside the same Node process as the game. `server/bootstrap.js` installs the admin routes on `core.app`, and Nginx sends the whole site to the gameplay process on `127.0.0.1:3000`.

That creates the wrong failure dependency: when `wobble.service` crashes, restarts, drains, or enters a restart loop, the operator also loses `/admin/` and the browser API that talks to the already-independent privileged operations helper.

The root-owned `wobble-ops` helper is already a separate systemd service/socket and can keep working while the game is unavailable. PR #78 makes the browser-facing control plane independent too.

## Goals

1. `/admin/` must remain reachable while `wobble.service` is stopped, restarting, draining, or crash-looping.
2. Existing admin access codes, sessions, RBAC and CSRF semantics must continue to work.
3. Infrastructure diagnostics, reliability history, audit reading and safe Operations must remain available without the gameplay process.
4. Game-dependent admin actions must never be faked as successful when the gameplay process is unavailable.
5. Existing moderation, sanctions and support mutations must keep their current transaction/audit semantics inside the gameplay process for this PR.
6. A Wobble restart initiated from the panel must no longer destroy the panel that initiated it.
7. No new public TCP port, arbitrary shell, arbitrary systemd unit, arbitrary URL proxy, or broader root capability may be introduced.
8. Nginx/shared-443/VPN/Xray topology must stay unchanged except for routing Wobble Control to the new local service.
9. Failure of the new control service must not affect gameplay availability.
10. The implementation must support cheap targeted validation before the normal long CI run.

## Explicit non-goals

This PR is not multi-host HA and does not try to survive loss of the VPS, Nginx, or the primary SQLite file itself. Database corruption/restore remains a separate disaster-recovery boundary.

It does not add automatic self-healing loops, external telemetry SaaS, SSH replacement, a generic command runner, or automatic changes to firewall/shared-443/VPN/Xray.

It also does not move every moderation/support mutation into a second SQLite writer. The gameplay process remains the executor for game-dependent mutations in #78.

## Target topology

```text
Internet
   |
   v
 Nginx
   |
   +-- /, /ws, game/auth APIs -----------------> wobble.service :3000
   |
   +-- /admin/, /api/admin/* ------------------> wobble-control.service :3001
                                                     |
                                                     +-- admin auth/session + safe DB reads
                                                     +-- infrastructure probes
                                                     +-- reliability reader
                                                     +-- /run/wobble-ops.sock
                                                     |
                                                     +-- allowlisted proxy ----------> :3000
                                                         only for game-dependent
                                                         admin endpoints
```

`wobble-control.service` binds **only** to `127.0.0.1`. Port 3001 is never opened in UFW and is not a public listener.

The new service has no `Requires=wobble.service` relationship. The two services restart independently.

## Why a gateway instead of moving every admin mutation

Moving all admin code into a second process immediately would turn routine moderation/support actions into a second writer against the gameplay SQLite file and would require redesigning the current atomic mutation + audit transactions.

That is unnecessary for the resilience objective.

Instead, #78 splits admin requests into two classes.

### Resilient/local routes

Handled directly by `wobble-control.service`:

- admin login/session/logout;
- resilient dashboard/control status;
- infrastructure diagnostics;
- Reliability Center reads;
- Operations status/run;
- audit reads;
- admin static assets.

These are the tools needed while the game is broken.

### Game-dependent routes

Forwarded through a **closed path allowlist** to `127.0.0.1:3000`:

- analytics that still depends on the gameplay admin model;
- player search/detail;
- Incident Center player timeline;
- player force logout/rename;
- moderation queue/case/transition;
- sanctions apply/revoke;
- any other explicitly classified existing game-admin endpoint.

The game keeps executing these routes with the same `AdminControlService`, database connection, RBAC checks, CSRF checks and atomic audit behavior it has today.

If the game is unavailable, the gateway returns a structured `503 { ok:false, error:"game-control-unavailable" }` instead of leaking an Nginx 502 or pretending the action succeeded.

Unknown `/api/admin/*` paths are **not** blindly proxied. A new route must be deliberately classified as local or game-dependent.

## Authentication and SQLite boundary

For #78, existing admin users/sessions remain in the current SQLite database so access codes and browser sessions do not need a credential migration.

The control service opens its own SQLite connection with WAL-compatible settings and a bounded `busy_timeout`. It performs only low-frequency control-plane writes (login/session/logout and local operation audit) and does not execute gameplay mutations.

Rules:

- never keep a control-plane SQLite transaction open across network/systemd/helper I/O;
- local audit writes happen only before/after the external operation, never while waiting on it;
- game-dependent mutations continue in `wobble.service` and are not duplicated by the gateway;
- reliability reads use a read-only query layer and must not run retention/pruning from the control service;
- a transient SQLite busy/error must fail the admin request, not affect gameplay;
- `wobble.service` must not acquire a dependency on `wobble-control.service`.

A future hardening PR may split admin identity/session state into a separate control database. That is intentionally not required to obtain process-level resilience now.

## New control service

Planned entrypoint: `server/controlPlane.js`.

Responsibilities:

- strict security headers for `/admin/`;
- serve only the admin static directory;
- instantiate `AdminAuthService` without taking ownership of gameplay migrations;
- expose resilient/local admin routes;
- proxy only allowlisted game-dependent admin routes;
- convert upstream connect/timeout failures into safe structured errors;
- expose a loopback-only `/health/control` endpoint for deployment/smoke checks;
- never listen on a public interface.

Suggested defaults:

```text
CONTROL_HOST=127.0.0.1
CONTROL_PORT=3001
GAME_ADMIN_ORIGIN=http://127.0.0.1:3000
```

`GAME_ADMIN_ORIGIN` is not user-controlled through HTTP and must resolve only to the fixed local gameplay backend.

## Game upstream proxy contract

The gateway is an application-level admin proxy, not a generic reverse proxy.

For each forwarded request it must:

- accept POST only;
- require an exact allowlisted path;
- cap request and response sizes;
- use a short bounded timeout;
- forward only required headers (`Cookie`, admin CSRF, content type and a generated request correlation ID);
- never forward arbitrary `Host`, `X-Forwarded-*`, authorization headers, or caller-selected upstream addresses;
- preserve safe 4xx/5xx JSON from the gameplay admin route;
- replace malformed/non-JSON upstream failures with a bounded safe error;
- return `game-control-unavailable` on connection refusal/timeout.

No public request can choose an upstream host, port, path outside the allowlist, command, systemd unit or filesystem path.

## Resilient dashboard

The default panel must stop assuming that a failed gameplay request means the admin session is dead.

A new control status model should distinguish:

- `control`: control service alive;
- `game`: reachable/unreachable, build identity when reachable;
- `maintenance`: on/off;
- `operations`: helper socket available/unavailable;
- `database`: admin/reliability read availability;
- `nginx`: service/probe status from infrastructure diagnostics.

When the gameplay process is down, the UI should say that explicitly and keep the operator logged in.

Game-dependent tabs remain visible according to RBAC but receive a clear degraded state such as “Сервер игры сейчас недоступен; раздел вернётся после запуска Wobble” rather than a generic network error.

## Infrastructure without game dependency

`AdminInfrastructure` currently receives `core.health()` directly. It must be changed so gameplay health is optional and obtained through a bounded local probe.

Systemd status, host memory/disk, Nginx, TLS, local ports and backup metadata must still render when the game health probe fails.

The service list should include `wobble-control.service` itself so an operator can distinguish “game down” from “control plane down”.

The public response still must not include process lists, private certificate material, arbitrary paths, environment secrets or command stderr.

## Reliability without game dependency

`ServiceReliability.report()` currently owns pruning as well as reading. The control service must not become a second telemetry writer.

Refactor the reporting queries into a read-only layer, for example `ServiceReliabilityReader`, shared by the live writer and the control service.

When the game is down:

- historical samples/events remain queryable;
- the report uses the latest known build from stored data when live build identity is unavailable;
- no pruning/upsert is attempted by the control service;
- a missing/corrupt reliability table degrades only the Reliability panel.

## Operations during a game outage

`AdminOperationsClient` already talks to `/run/wobble-ops.sock`, so it naturally belongs in the independent control service.

The following remain available when the game is stopped:

- backup create/verify (subject to their own preconditions);
- Nginx config test + reload;
- maintenance enable/disable;
- Wobble restart/start recovery path;
- operation status.

Operations keep the existing owner-only capability, CSRF requirement, confirmation flow, allowlist and audit events.

The privileged helper still owns all root work. `wobble-control.service` receives no sudo/root shell.

## Restart UX

Today the admin page schedules a reload after `wobble.restart` because its own backend is being restarted.

With #78 that behavior is wrong and should be removed.

After the helper accepts a restart, the panel should remain open and poll control status through the independent service. It can show a bounded sequence such as:

1. maintenance enabled / drain requested;
2. waiting for active match completion;
3. gameplay process temporarily unavailable;
4. new gameplay process reachable;
5. maintenance removed / ready.

A timeout must end in a visible warning; it must never silently claim the restart succeeded.

## Nginx changes

Add explicit Wobble Control locations ahead of the general game location:

- `/admin/` -> `127.0.0.1:3001`;
- `/api/admin/` -> `127.0.0.1:3001`.

Keep:

- `/ws` -> gameplay process with the existing maintenance gate;
- normal game/static/auth APIs -> gameplay process;
- `/health/ops` blocked publicly;
- `/health/control` blocked publicly;
- shared-443 stream routing unchanged.

No new public listener or certificate is required.

## systemd boundary

Add `deploy/wobble-control.service` with:

- `User=wobble` / `Group=wobble` for this PR to avoid a permissions migration of the existing SQLite file;
- independent `Restart=always`;
- no `Requires=wobble.service`;
- strict systemd sandbox comparable to `wobble.service`;
- only loopback/Unix address families required;
- no capability/sudo/root escalation.

The installer enables the control service independently and validates it before switching Nginx admin routing.

A control-service crash must leave `wobble.service` untouched.

## Deployment order

To avoid locking the operator out during the cutover:

1. install/update code and dependencies;
2. install/reload `wobble-control.service`;
3. start control service and require successful local `/health/control`;
4. install Nginx admin routing;
5. run `nginx -t`;
6. reload Nginx;
7. continue the normal Wobble deploy/restart flow.

On failure before step 6, the old admin path remains in effect.

## Failure matrix / acceptance criteria

### Gameplay stopped

With `wobble.service` stopped:

- `https://wobbles.ru/admin/` still loads;
- an existing admin access code can log in;
- session refresh/logout work;
- Server/Infrastructure still shows systemd/Nginx/TLS/disk/backup data and clearly marks Wobble down;
- Reliability history remains readable;
- Operations remains usable;
- game-dependent endpoints return structured `game-control-unavailable`;
- restarting Wobble from Operations does not reload/kill the admin UI.

### Control plane stopped

With `wobble-control.service` stopped:

- gameplay, public HTTP and `/ws` continue normally;
- no automatic game restart is triggered;
- Nginx returns failure only for admin routes;
- root helper and Wobble remain independent.

### Root helper stopped

- Wobble Control still loads;
- read-only diagnostics still work;
- Operations reports helper unavailable;
- no fallback shell/systemctl path exists.

### Gameplay returns

- the existing admin session remains valid;
- degraded tabs recover without a full login cycle;
- no duplicate mutation is replayed automatically.

## Regression tests

Targeted tests should cover at least:

1. gateway allowlist rejects unknown/admin-like paths without contacting upstream;
2. connection refusal/timeout becomes `game-control-unavailable`;
3. upstream 401/403/409 application responses are preserved safely;
4. request/response size bounds;
5. no arbitrary host/port/header forwarding;
6. login/session/infrastructure/reliability/operations work with no game listener;
7. admin session expiry is still distinguished from gameplay unavailability;
8. Infrastructure returns partial data when game health is unavailable;
9. Reliability reader performs no writes/pruning;
10. operation confirmation/audit semantics remain unchanged;
11. restart UI no longer uses blind `window.location.reload()`;
12. Nginx routes only admin paths to the control service and leaves `/ws` on port 3000;
13. `/health/control` is unreachable publicly;
14. systemd unit has no dependency that stops the control service with Wobble;
15. a control-service failure cannot terminate or signal the game;
16. existing gameplay/multiplayer/admin tests remain green.

## CI strategy

Because the normal suite/browser smoke is expensive, #78 should use the same workflow discipline as #77:

- build the change as one coherent batch;
- run Prettier/ESLint + focused control-plane/Nginx/systemd tests first;
- run targeted admin regressions next;
- open PR only after the fast preflight is green;
- run the normal full CI once;
- batch review fixes on a staging branch and update the PR once, rather than triggering the long CI for every small review comment.

## Definition of done

PR #78 is done when stopping `wobble.service` no longer removes the operator’s ability to authenticate to Wobble Control, inspect infrastructure/reliability, and invoke the existing safe root-helper operations — while gameplay-dependent actions fail explicitly and safely until the game process returns.
