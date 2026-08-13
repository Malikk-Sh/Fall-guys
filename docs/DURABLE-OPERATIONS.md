# Durable Operations

Wobble Control treats privileged server operations as durable state machines rather than browser requests.

## Ownership and storage

`wobble-ops.service` is the authoritative lifecycle owner. It writes an atomic bounded journal to
`/var/lib/wobble-ops/operations.json`. The directory is writable only through the hardened root helper;
the resulting journal is world-readable because it contains only allowlisted action IDs, lifecycle states,
timestamps, durations and bounded reason codes. It never stores command lines chosen by a user, stdout,
stderr, tokens, cookies, access codes or filesystem paths supplied by HTTP clients.

The unprivileged Control Plane reads that sanitized journal and returns it from
`/api/admin/operations/status`. No gameplay SQLite migration or second gameplay database writer is needed.

## State machine

Operations start as `queued` and move through the smallest valid path for their type:

- ordinary oneshots: `queued -> running -> succeeded|failed`;
- service recovery: `queued -> running -> verifying -> succeeded|failed`;
- graceful Wobble restart: `queued -> running -> drain -> verifying -> succeeded|failed`.

Only one non-terminal privileged operation may exist at a time. This makes recovery deterministic and keeps
operator UI/audit history from claiming two conflicting server transitions are both authoritative.

## Recovery

On helper startup, unfinished ordinary operations are closed as `failed/helper-restarted`: their child
process lifetime cannot be proven after the helper itself died. A graceful restart is different: its existing
`/run/wobble-ops/restart.json` marker carries the durable operation ID, so the helper resumes that exact
operation and continues the readiness monitor. A restart marker that disappears while the durable operation
is still non-terminal is failed closed as `restart-state-lost`.

The journal survives browser reloads, Control Plane restarts, helper restarts and VPS reboot. The runtime
maintenance flag and restart marker remain under `/run` because they describe current boot/process ownership;
the persistent journal records the operator-visible history across those lifetimes.

## UI contract

The Operations panel shows the active lifecycle and bounded newest-first history. Buttons are disabled while
an operation is non-terminal. Reloading the page rehydrates the active operation from the server and resumes
polling it until `succeeded` or `failed`; success is never inferred merely from a browser timeout or page
reload.
