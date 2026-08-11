# Changelog

All notable public Wobble Rush changes are recorded here from the beta release process onward.

## Unreleased

### Added

- Four campaign presentation worlds across the ten co-op chapters: Cloud Factory, Storm Zone, Reactor and Collapse.
- Stronger Energy Core, Signals and finale feedback for the co-op campaign.
- A private per-account list of excluded matchmaking partners with safe restore.
- A verified tag-driven GitHub Release pipeline for future beta and stable releases.
- A local-only human moderation queue with report evidence snapshots, auditable case statuses and automatic reopening when new reports arrive.
- Account self-service controls for active sessions, staged retry-safe recovery-code rotation and explicit device sign-out.

### Changed

- Public release tags are required to match the base version in both `package.json` and `package-lock.json`.
- Release candidates must come from `main` and pass formatting, lint, the full Node regression suite and the two-browser Playwright smoke before GitHub publishes them.

## Release naming

Prereleases use tags such as `v2.6.0-beta.1`; stable releases use tags such as `v2.6.0`.
