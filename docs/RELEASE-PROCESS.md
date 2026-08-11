# Wobble Rush release process

This document defines the public beta release path. A release is an immutable Git tag that points to a commit already contained in `main`.

## Version and tag rules

- `package.json` and `package-lock.json` must contain the same base version.
- Stable tags use `vMAJOR.MINOR.PATCH`, for example `v2.6.0`.
- Prerelease tags keep the package base version and add a suffix, for example `v2.6.0-beta.1` or `v2.6.0-rc.1`.
- `deploy/check-release.mjs` rejects malformed tags, version drift, and a tag that does not point to the checked-out commit.

## Creating a beta release

1. Merge the intended beta changes into `main` and wait for `Verify Wobble Rush` to pass.
2. Make sure the project version is the intended base version.
3. Create the tag from that exact `main` commit:

```bash
git switch main
git pull --ff-only
git tag -a v2.6.0-beta.1 -m "Wobble Rush 2.6.0 beta 1"
git push origin v2.6.0-beta.1
```

4. `Publish Wobble Rush Release` runs automatically for the tag. It requires the tagged commit to be contained in `main`, validates tag/version consistency, runs formatting, lint, the full Node test suite and the two-browser Playwright smoke test, then creates a GitHub Release.
5. Tags containing a suffix such as `-beta.1` are published as GitHub prereleases. Stable tags are normal releases.

If verification fails, do not move or reuse the tag. Fix the problem on `main` and create the next prerelease tag, for example `v2.6.0-beta.2`.

## Production identity

The production server already exposes the package version and exact build commit through `/health`. After deploying a public beta, compare those values with the GitHub Release tag commit before announcing the build.

Production deploys can now pin an exact published release tag. The installer still verifies `/health` build identity after restart, so the release tag, package version and exact build SHA remain tied together.

## Production deployment

After a release exists, deploy the exact tag instead of floating `main`:

```bash
RELEASE_TAG=v2.6.0-beta.1 bash /opt/wobble/deploy/install.sh
```

A successful tagged deployment stores `SAVED_RELEASE_TAG` in `/etc/wobble-deploy.conf`. Ordinary later runs stay pinned to that exact release. To deploy a newer release, pass its tag explicitly. To intentionally return to branch mode, pass an explicitly empty tag, for example `RELEASE_TAG= BRANCH=main bash /opt/wobble/deploy/install.sh`.

The installer first requires the tag to have a non-draft published GitHub Release, then refuses to overwrite a previously seen local tag if the remote tag object ever changes. It verifies that the tag matches `package.json` and `package-lock.json`, checks out the tag commit detached, writes both release tag and build SHA into the service environment, and requires the deploy smoke to observe the expected version, commit and release identity from `/health`.
