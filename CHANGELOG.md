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
- Content & Customization 2.0: 60 original cosmetics across four themed collections (Space Trouble, Food Fight, Neon Arcade, Pirate Panic), including three Mythic bodies.
- A `back` cosmetic slot for backpacks, tanks, chests and barrels, persisted per account and visible on remote players.
- Emotes: a four-slot emote loadout, an in-game emote button and wheel, and a rate-limited server-validated emote event.
- A full Wardrobe screen with a shared-pipeline 3D preview, category tabs, ownership/rarity/collection/favourite filters, collection progress, randomised outfits and one-time unlock cards.
- Rarity, collection and unlock metadata in the shared catalog, with a declarative unlock resolver and a catalog validator.
- Reactive cosmetic presentation: pooled particle trails, secondary accessory motion, victory effects and quality-aware Mythic fallbacks.

### Changed

- Cosmetic unlocks are resolved from declarative catalog metadata instead of per-item branches, and new content is granted only by the server.
- The account panel now summarises the equipped outfit; the full catalog moved to the Wardrobe screen.

- Public release tags are required to match the base version in both `package.json` and `package-lock.json`.
- Release candidates must come from `main` and pass formatting, lint, the full Node regression suite and the two-browser Playwright smoke before GitHub publishes them.

## Release naming

Prereleases use tags such as `v2.6.0-beta.1`; stable releases use tags such as `v2.6.0`.
