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

`CI ready` is the final aggregate status. It succeeds only when every required group succeeds.

The desktop, mobile, and fullscreen jobs use zero retries. `full-match` gets one retry because it is intentionally timing-sensitive and runs in wall-clock time. A test that needs a retry is shown as flaky in the job summary instead of being silently hidden.

## Failure diagnostics

Each browser job keeps the standard GitHub annotations and HTML Playwright report. On failure, the HTML report is uploaded as `playwright-report-<suite>` for seven days.

A custom reporter also writes the final failing test, project, source location, retry number, and the first part of the error directly to the GitHub Actions step summary. This is the first place to inspect before downloading the full trace.

## Why workers stay at one

Each Playwright job still uses `workers: 1` and `fullyParallel: false`. Multiplayer tests share a local game server and some scenarios intentionally coordinate multiple browser contexts. Parallelism is provided at the GitHub job level, where every suite receives an isolated runner and server, instead of adding timing races inside a suite.
