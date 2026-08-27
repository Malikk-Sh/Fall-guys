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
npm run test:e2e:portal
```

`desktop:fast` intentionally excludes `full-match.spec.js`. The full-match suite runs separately because it drives two real browsers through a real-time race and cannot be shortened without changing what it verifies.

`test:e2e:portal` is the only command with its own Playwright config (`playwright.portal.config.js`), and that is deliberate. It checks the static build that ships to a game portal, so it needs a different server — the build served from a **subpath**, with the root answering 404 — and it must not have our game server running at all, or the suite could pass because something nearby answered. `webServer` is a config-level setting rather than a project-level one, so a portal entry in the shared config was started even by commands whose tests never touch it; a separate config is what keeps the lanes independent in both directions. The command rebuilds `dist/yandex` on every run and never reuses a running server, because a leftover one would serve a stale build.

## GitHub Actions layout

`Fast quality gate` must pass before expensive jobs start. After that, GitHub runs these groups in parallel:

- `Node tests (server)`
- `Node tests (client)`
- `Production smoke`
- `E2E (desktop)`
- `E2E (mobile)`
- `E2E (fullscreen)`
- `E2E (full-match)`
- `E2E (portal)`

`CI ready` is the final aggregate status. It succeeds only when every required group succeeds. A small compatibility job named `test` follows it because branch protection still requires the historical check name.

The portal lane runs the built artifact in two browser profiles — desktop and mobile landscape. The mobile one is not decoration: the audience of a game portal is mobile, and a suite that only ever opened the build in a desktop browser would be declaring protected something it never looked at.

The desktop, mobile, fullscreen, full-match, and portal jobs use zero retries. Timing-sensitive failures are surfaced directly together with their diagnostics instead of being hidden by a retry.

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
- a 300-seed alternate physics sweep with a meaningful baseline-aware floor;
- reliability-sensitive server tests three times;
- a staged local multi-room WebSocket load gate using real co-op clients and `PLAYER_STATE` traffic;
- deterministic reconnect/churn stress using real session resume and room lifecycle paths;
- matchmaking and multiplayer browser scenarios three times on desktop and mobile;
- the real-time two-browser full-match suite three times with **zero retries**.

### Nightly 2.0 baseline-aware budgets

The first scheduled GitHub-hosted baseline on commit `550f18ba5f28e1639c05b685ba3fa348c3a31524` produced:

- `99 / 300` good alternate physics seeds;
- `20.9 ms` server event-loop p95 during the 24-room WebSocket load;
- `108 MB` server RSS during the same load.

A post-merge manual Nightly 2.0 run on commit `a4c5b8b9d7c086b4a688ddc85466e027e925f6a8` confirmed the baseline with `99 / 300` good seeds, `21 ms` event-loop p95, and `97 MB` RSS at the original 24-room stage.

The current nightly policy is:

| Metric         | Reference |     Warning |  Hard failure |
| -------------- | --------: | ----------: | ------------: |
| Good seeds     |  99 / 300 |           — | fewer than 75 |
| Event-loop p95 |   20.9 ms | above 45 ms |   above 60 ms |
| RSS            |    108 MB |           — |  above 180 MB |

The seed floor of 75 leaves roughly 24% headroom below the first 99-seed baseline while preventing a catastrophic `99 → 1` regression from staying green. The event-loop hard budget is almost three times the first measured p95 and remains well below the server's overload threshold; 45 ms is a non-failing early warning. The RSS budget leaves substantial headroom for GitHub runner/V8 variation rather than treating ordinary heap growth as a leak.

These values are workflow configuration, not hidden assertion constants. The load gate reads:

- `WOBBLE_LOAD_BASELINE_EVENT_LOOP_P95_MS`
- `WOBBLE_LOAD_WARN_EVENT_LOOP_P95_MS`
- `WOBBLE_LOAD_MAX_EVENT_LOOP_P95_MS`
- `WOBBLE_LOAD_BASELINE_RSS_MB`
- `WOBBLE_LOAD_MAX_RSS_MB`

The physics sweep continues to use `MIN_GOOD_SEEDS`; nightly sets it to `75` and records the reference baseline separately for its Step Summary. The budgets should be revisited after several more scheduled GitHub-hosted runs, not loosened by increasing retries or timeouts.

### Staged WebSocket load

The daily WebSocket load lane keeps one real local gameplay server process alive and runs the existing load gate sequentially at these concurrency levels:

| Stage | Rooms | Clients | Traffic duration |
| ----: | ----: | ------: | ---------------: |
|     1 |    24 |      48 |              12s |
|     2 |    48 |      96 |              12s |
|     3 |    96 |     192 |              12s |

Every stage follows the real WebSocket flow (`HELLO → CREATE → JOIN → READY → START → PLAYER_STATE`) and keeps localhost loopback source sharding instead of disabling production per-IP protections. A stage must pass before the next one starts. The sequence stops on the first failure, so a broken 48-room stage does not waste runner time attempting 96 rooms.

The existing hard gates apply independently to each stage: readiness, expected rooms/players, zero `invalidMessages`, `socketSendFailures`, `handlerErrors`, and `capacityRejected`, plus the configured event-loop p95 and RSS budgets. The staged summary also records sessions, snapshot load skips, movement verification failures, and late-packet drops so scaling behavior is visible without opening the full logs.

The GitHub Step Summary contains a compact table like:

```text
| Stage | Rooms | Clients | p95 | RSS | Snapshot skips Δ | Result |
```

The staged job keeps the existing 10-minute job timeout. The normal three-stage plan should take roughly tens of seconds of traffic plus room setup, not turn daily nightly into a long soak test.

### Reconnect / churn stress

The daily reconnect/churn lane is a separate deterministic real-WebSocket scenario rather than another steady load stage. Its default profile is:

- 12 active co-op rooms / 24 clients;
- three rapid disconnect/resume cycles while state traffic continues;
- four stale-old-socket races where a new socket resumes before the old socket closes;
- a 24-client reconnect storm with a small deterministic stagger;
- 100 create/join/start/explicit-leave room churn iterations in bounded batches.

The probe uses `terminate()` to model an actual network drop and resumes with the real session token. The stale-socket scenario then toggles real presence state after the old socket closes and verifies that the resumed player remains online. Room churn uses the production `leave` message so the test measures lifecycle cleanup without weakening reconnect grace, session TTL, capacity or per-IP protection.

The reconnect/churn gate requires:

- every attempted resume to preserve player identity and succeed;
- `resumeFailed`, `handlerErrors`, `socketSendFailures`, `invalidMessages`, and `capacityRejected` deltas to stay zero;
- no duplicate-player or room/player/session count mismatch observations;
- the 20–40 client storm to leave `/health/ready` healthy;
- peak rooms, players, and sessions to remain inside the expected base-load bound;
- all churn rooms to be reclaimed and final rooms/players/sessions to return to the pre-test baseline;
- the established server safety budgets (`60 ms` event-loop p95 and `180 MB` RSS) to remain intact.

The churn tool writes machine-readable JSON through `WOBBLE_CHURN_RESULT_PATH` and a compact Step Summary through `WOBBLE_CHURN_SUMMARY_PATH`. A failure names the concrete invariant or metric rather than relying on a bare exit code.

Useful local reconnect/churn check:

```bash
WOBBLE_CHURN_ROOMS=12 \
WOBBLE_CHURN_RAPID_CYCLES=3 \
WOBBLE_CHURN_STORM_CLIENTS=24 \
WOBBLE_CHURN_ROOM_ITERATIONS=100 \
WOBBLE_CHURN_MIN_RESUME_SUCCESS_RATE=1 \
WOBBLE_CHURN_BASELINE_EVENT_LOOP_P95_MS=20.9 \
WOBBLE_CHURN_MAX_EVENT_LOOP_P95_MS=60 \
WOBBLE_CHURN_BASELINE_RSS_MB=108 \
WOBBLE_CHURN_MAX_RSS_MB=180 \
npm run churn:gate
```

Reconnect/churn is still a short daily stress lane. Longer repeated-load and leak/degradation testing belongs to the separate weekly soak/endurance work, not to retries or a larger daily timeout.

### Weekly multiplayer soak

`.github/workflows/weekly-soak.yml` is deliberately separate from the daily reliability workflow. It runs once per week at `04:47 UTC` on Sunday and supports `workflow_dispatch` for an explicit manual run. The normal plan is **30 minutes** of workload on one gameplay server process; the job timeout is 45 minutes only to cover npm setup, room setup/cleanup, summary generation and artifact upload around that fixed 30-minute workload.

The six default five-minute phases are:

| Phase           | Base rooms | Additional churn                          |
| --------------- | ---------: | ----------------------------------------- |
| `base-24`       |         24 | no                                        |
| `base-48`       |         48 | no                                        |
| `load-24-churn` |         24 | periodic real reconnect/room-churn pulses |
| `load-48-churn` |         48 | periodic real reconnect/room-churn pulses |
| `burst-96`      |         96 | no                                        |
| `recovery-24`   |         24 | no                                        |

Every base-load phase reuses the normal `loadGate.mjs`, so it still exercises real `HELLO → CREATE → JOIN → READY → START → PLAYER_STATE`, loopback source sharding and the established `60 ms` event-loop / `180 MB` RSS hard budgets. Churn phases run smaller deterministic `churnProbe.mjs` pulses concurrently with the base load, exercising real network-style disconnect, session resume, stale-socket handling and create/join/start/leave lifecycle without disabling reconnect grace, rate limits or capacity protections.

`soakProbe.mjs` samples `/health` every 20 seconds by default and writes JSON plus CSV time-series data. Each row records event-loop p95, RSS, heap used, rooms, players, sessions, active sockets, active matches and the main reliability counters. The workflow preserves:

- raw probe JSON;
- final gate JSON;
- CSV time series;
- Markdown summary;

for 21 days. The gameplay server log is uploaded only when the soak job fails.

Weekly memory checking intentionally does **not** require `RSS end == RSS start`. V8 can retain committed memory after load. The gate instead checks:

- the established hard p95/RSS budgets and `/health/ready`;
- zero critical error deltas including `handlerErrors`, `socketSendFailures`, `resumeFailed`, `capacityRejected` and snapshot load skips;
- rooms/players/sessions return to the pre-soak baseline;
- the final `recovery-24` phase for strongly monotonic RSS/heap growth.

Recovery growth above `32 MB` RSS or `24 MB` heap is an early warning when at least 80% of recovery samples are non-decreasing. Strong growth above `64 MB` RSS or `48 MB` heap under the same monotonic condition is a hard leak/degradation signal. These recovery thresholds are configurable and intentionally conservative until several GitHub-hosted weekly runs establish a trend; the raw artifact remains the source for later tightening.

The weekly workflow has no retry mechanism and does not change any existing daily timeout. It is local GitHub-runner stress only; it must not be pointed at production automatically.

For a shortened local orchestration smoke check, keep the explicit short-run opt-in so the production weekly minimum cannot be weakened accidentally:

```bash
WOBBLE_SOAK_PHASE_SECONDS=30 \
WOBBLE_SOAK_SAMPLE_MS=5000 \
WOBBLE_SOAK_CHURN_PULSE_MS=10000 \
WOBBLE_SOAK_ALLOW_SHORT=1 \
WOBBLE_SOAK_PROBE_RESULT_PATH=/tmp/wobble-soak-probe.json \
WOBBLE_SOAK_CSV_PATH=/tmp/wobble-soak.csv \
npm run soak:probe

WOBBLE_SOAK_ALLOW_SHORT=1 \
WOBBLE_SOAK_PROBE_RESULT_PATH=/tmp/wobble-soak-probe.json \
WOBBLE_SOAK_RESULT_PATH=/tmp/wobble-soak-result.json \
WOBBLE_SOAK_SUMMARY_PATH=/tmp/wobble-soak-summary.md \
npm run soak:summary
```

Start one local gameplay server first (`npm start`) for the commands above. A real scheduled/manual weekly workflow does not set `WOBBLE_SOAK_ALLOW_SHORT`; its planned duration must remain at least 1800 seconds.

Useful local load checks:

```bash
node server/loadGate.mjs 24 12

WOBBLE_LOAD_BASELINE_EVENT_LOOP_P95_MS=20.9 \
WOBBLE_LOAD_WARN_EVENT_LOOP_P95_MS=45 \
WOBBLE_LOAD_MAX_EVENT_LOOP_P95_MS=60 \
WOBBLE_LOAD_BASELINE_RSS_MB=108 \
WOBBLE_LOAD_MAX_RSS_MB=180 \
WOBBLE_LOAD_RESULT_PATH=/tmp/wobble-load.json \
WOBBLE_LOAD_SUMMARY_PATH=/tmp/wobble-load.md \
node server/loadGate.mjs 24 12

WOBBLE_LOAD_STAGES=24:12,48:12,96:12 \
WOBBLE_LOAD_BASELINE_EVENT_LOOP_P95_MS=20.9 \
WOBBLE_LOAD_WARN_EVENT_LOOP_P95_MS=45 \
WOBBLE_LOAD_MAX_EVENT_LOOP_P95_MS=60 \
WOBBLE_LOAD_BASELINE_RSS_MB=108 \
WOBBLE_LOAD_MAX_RSS_MB=180 \
npm run load:staged
```

Start one local gameplay server first (`npm start`) unless `WOBBLE_WS_URL` and `WOBBLE_HTTP_URL` point at another explicitly approved target. The staged, churn and soak gates intentionally reuse the real gameplay server path. Do not use the automated load, churn or soak gates against production by default.

The nightly full-match lane disables retries deliberately: nightly stress should expose any intermittent failure as a red run.

Useful local seed checks:

```bash
ONLY=130 node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
MIN_GOOD_SEEDS=75 SEEDS=300 node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
```

`ONLY=<seed>` exits non-zero when any modeled timing mode cannot finish. `MIN_GOOD_SEEDS` makes the wider sweep usable as an automated reliability threshold.

## Failure diagnostics

Each browser job keeps the standard GitHub annotations and HTML Playwright report. On failure, the HTML report is uploaded as `playwright-report-<suite>` for seven days. Nightly browser reports are retained for fourteen days.

A custom reporter also writes the final failing test, project, source location, retry attempts, timing, and the first part of the error directly to the GitHub Actions step summary. This is the first place to inspect before downloading the full trace.

## Why workers stay at one

Each Playwright job still uses `workers: 1` and `fullyParallel: false`. Multiplayer tests share a local game server and some scenarios intentionally coordinate multiple browser contexts. Parallelism is provided at the GitHub job level, where every suite receives an isolated runner and server, instead of adding timing races inside a suite.
