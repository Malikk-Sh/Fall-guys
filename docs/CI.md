# CI and local verification

Wobble Rush uses a two-stage verification pipeline: a cheap quality gate first, then independent expensive jobs in parallel.

## Local feedback loop

After creating a Codespace, `.devcontainer/devcontainer.json` installs exact npm dependencies, Chromium, system browser dependencies, and enables the repository pre-push hook.

Run the fast gate manually at any time:

```bash
npm run preflight
```

It checks Prettier, merge markers, shell syntax, and ESLint. The pre-push hook runs the same command so formatting and lint errors should be caught before GitHub Actions starts.

For a broader non-browser check:

```bash
npm run preflight:full
```

This adds both Node test groups.

## Targeted browser commands

```bash
npm run test:e2e:desktop:fast
npm run test:e2e:mobile
npm run test:e2e:fullscreen
npm run test:e2e:full-match
npm run test:e2e:matchmaking
npm run test:e2e:menu
```

`desktop:fast` intentionally excludes `full-match.spec.js`. The full-match suite runs separately because it drives two real browsers through a real-time race and cannot be shortened without changing what it verifies.

## GitHub Actions layout

`Fast quality gate` must pass before expensive jobs start. After that, GitHub runs these groups in parallel:

- `Node tests (server)`
- `Node tests (client)`
- `Production smoke`
- `E2E (desktop)`
- `E2E (mobile)`
- `E2E (fullscreen)`
- `E2E (full-match)`

`CI ready` is the final aggregate status. It succeeds only when every required group succeeds. A small compatibility job named `test` follows it because branch protection still requires the historical check name.

The desktop, mobile, fullscreen, and full-match jobs use zero retries. Timing-sensitive failures are surfaced directly together with their diagnostics instead of being hidden by a retry.

## Browser timing and flaky summaries

Every Playwright CI job writes structured timing information to the GitHub Step Summary:

- final test status and pass/fail/skip counts;
- total Playwright test-execution time including retries;
- retry-attempt and flaky-test counts;
- the five slowest final test attempts;
- the final failure message and source location when a test fails.

The normal CI workflow also records E2E lane wall-clock time including npm/browser setup. This makes it possible to distinguish a slow test from a slow runner or dependency installation step.

## Full-match runtime diagnostics

`full-match.spec.js` uses the same steering policy as `tools/e2eSeedSweep.mjs`. The browser run additionally records test-only telemetry without changing game behavior:

- actual intervals between browser-local control updates;
- median/p95/max `requestAnimationFrame` intervals and estimated FPS;
- maximum observed lateral position and velocity;
- checkpoint, respawn and remote-player state on failure.

A failed finish assertion includes these values directly in the error message. Nightly full-match stress also enables successful-run diagnostics in the job log.

## Nightly reliability stress

`.github/workflows/nightly-stress.yml` runs daily and can also be started manually. It is intentionally separate from required PR checks so reliability stress does not increase normal feedback latency.

The nightly workflow runs these groups after its own quality gate:

- the fixed full-match seed across modeled FPS/poll/latency combinations;
- a 300-seed alternate physics sweep with at least one valid seed required;
- reliability-sensitive server tests three times;
- a local multi-room WebSocket load gate using real co-op clients and `PLAYER_STATE` traffic;
- matchmaking and multiplayer browser scenarios three times on desktop and mobile;
- the real-time two-browser full-match suite three times with **zero retries**.

The WebSocket load lane starts a real local gameplay server, waits for `/health/ready`, creates 24 co-op rooms (48 clients), sends state traffic for 12 seconds, and records a machine-readable before/after result. It fails when the server stops being ready, the expected rooms/players are missing, or `invalidMessages`, `socketSendFailures`, `handlerErrors`, or `capacityRejected` increase. Event-loop p95, RSS, snapshot load skips, and other counters are written to the GitHub Step Summary as baseline telemetry. The first gate deliberately does not add a new hard event-loop or RSS budget before several GitHub runner samples exist; readiness still enforces the server's existing overload threshold.

Useful local load checks:

```bash
node server/loadGate.mjs 24 12
WOBBLE_LOAD_RESULT_PATH=/tmp/wobble-load.json \
WOBBLE_LOAD_SUMMARY_PATH=/tmp/wobble-load.md \
node server/loadGate.mjs 24 12
```

Start the local gameplay server first (`npm start`) unless `WOBBLE_WS_URL` and `WOBBLE_HTTP_URL` point at another explicitly approved target. Do not use the automated load gate against production by default.

The nightly full-match lane disables retries deliberately: nightly stress should expose any intermittent failure as a red run.

Useful local seed checks:

```bash
ONLY=130 node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
MIN_GOOD_SEEDS=1 SEEDS=300 node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
```

`ONLY=<seed>` exits non-zero when any modeled timing mode cannot finish. `MIN_GOOD_SEEDS` makes the wider sweep usable as an automated reliability threshold.

## Failure diagnostics

Each browser job keeps the standard GitHub annotations and HTML Playwright report. On failure, the HTML report is uploaded as `playwright-report-<suite>` for seven days. Nightly browser reports are retained for fourteen days.

A custom reporter also writes the final failing test, project, source location, retry attempts, timing, and the first part of the error directly to the GitHub Actions step summary. This is the first place to inspect before downloading the full trace.

## Why workers stay at one

Each Playwright job still uses `workers: 1` and `fullyParallel: false`. Multiplayer tests share a local game server and some scenarios intentionally coordinate multiple browser contexts. Parallelism is provided at the GitHub job level, where every suite receives an isolated runner and server, instead of adding timing races inside a suite.
