# Wobble Rush agent workflow

Before pushing a change, run:

```bash
npm run preflight
```

For changes that touch server/gameplay behavior, prefer the smallest relevant targeted test first, then run:

```bash
npm run preflight:full
```

For browser work, use the targeted commands in `docs/CI.md` before waiting for the complete GitHub Actions matrix.

Do not fix browser failures by increasing timeouts or global retries unless the product behavior genuinely requires more time. Reproduce the failing suite, fix the lifecycle/state invariant, and keep long real-time scenarios isolated from fast feedback.
