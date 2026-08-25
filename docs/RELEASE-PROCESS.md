# Wobble Rush release process

This document defines the public beta release path. A release is an immutable Git tag that points to a commit already contained in `main`.

## Version and tag rules

- `package.json` and `package-lock.json` must contain the same base version.
- Stable tags use `vMAJOR.MINOR.PATCH`, for example `v2.6.0`.
- Prerelease tags keep the package base version and add a suffix, for example `v2.6.0-beta.1` or `v2.6.0-rc.1`.
- `deploy/check-release.mjs` rejects malformed tags, version drift, and a tag that does not point to the checked-out commit.

## Creating a beta release

Actions → **Tag Wobble Rush Release** → Run workflow. That is the whole step.

The workflow tags the head of `origin/main` and picks the next free prerelease number itself. Both
halves matter, and both exist because the manual path failed three times in a row: `v2.6.0-beta.2`
and `v2.6.0-beta.4` were created on a stale local `main` (the first took production down with a
502), and `v2.6.0-beta.5` reused a number that was already taken. Tags are immutable, so each of
those mistakes is permanent.

`Publish Wobble Rush Release` then runs on the pushed tag exactly as before: it requires the tagged
commit to be contained in `main`, validates tag/version consistency, runs formatting, lint, the full
Node test suite and the two-browser Playwright smoke test, and only then creates the GitHub Release.
Prerelease tags are published as GitHub prereleases.

If that verification fails, do not move or reuse the tag. Fix `main` and run the workflow again; it
will pick the next number.

### Tagging by hand

Still possible, and still the same rules. Keep the fetch inside the chain — a tag created on a stale
`main` is exactly the failure the workflow removes:

```bash
git switch main && git pull --ff-only && \
tag="$(node deploy/next-release-tag.mjs)" && \
git tag -a "$tag" -m "Wobble Rush $tag" && \
git push origin "refs/tags/$tag"
```

Push that one ref, never `--tags`: `--tags` sends every local tag, and any stray `v*` among them
becomes immutable on the remote and starts the publishing workflow.

`node deploy/next-release-tag.mjs [channel]` prints the next free tag for the current package
version, using the same rule the workflow does.

## Production identity

The production server already exposes the package version and exact build commit through `/health`. After deploying a public beta, compare those values with the GitHub Release tag commit before announcing the build.

Production deploys can now pin an exact published release tag. The installer still verifies `/health` build identity after restart, so the release tag, package version and exact build SHA remain tied together.

## Production deployment

```bash
bash /opt/wobble/deploy/deploy-latest.sh              # latest stable release
bash /opt/wobble/deploy/deploy-latest.sh --prerelease # latest beta/rc as well
bash /opt/wobble/deploy/deploy-latest.sh --check      # only report what is available
```

The tag is read from the GitHub Releases API, so there is nothing to type and nothing to mistype.
The repository is public, so no token is involved. Drafts are never deployed; prereleases only with
`--prerelease`, because publishing a beta must not by itself move the live server onto it. If the
release already installed matches, the script says so and stops.

Everything after the tag is resolved is `install.sh` as before — verified backup, cutover, restart
and the `/health` build-identity check. `deploy-latest.sh` deliberately holds no install logic of
its own.

To deploy one exact tag instead:

```bash
RELEASE_TAG=v2.6.0-beta.6 bash /opt/wobble/deploy/install.sh
```

A successful tagged deployment stores `SAVED_RELEASE_TAG` in `/etc/wobble-deploy.conf`. Ordinary
later runs stay pinned to that exact release. To intentionally return to branch mode, pass an
explicitly empty tag, for example `RELEASE_TAG= BRANCH=main bash /opt/wobble/deploy/install.sh`.
