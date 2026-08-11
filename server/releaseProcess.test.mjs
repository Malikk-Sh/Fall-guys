import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReleaseTag, validateReleaseVersions } from '../deploy/releasePolicy.mjs';

test('release tags keep package version and prerelease label separate', () => {
  assert.deepEqual(parseReleaseTag('v2.6.0-beta.1'), {
    tag: 'v2.6.0-beta.1',
    version: '2.6.0',
    prerelease: true,
    prereleaseLabel: 'beta.1'
  });
  assert.deepEqual(parseReleaseTag('v2.6.0'), {
    tag: 'v2.6.0',
    version: '2.6.0',
    prerelease: false,
    prereleaseLabel: null
  });
});

test('release policy rejects malformed tags and version drift', () => {
  assert.equal(parseReleaseTag('2.6.0-beta.1'), null);
  assert.equal(parseReleaseTag('v2.6-beta.1'), null);
  assert.throws(
    () =>
      validateReleaseVersions({
        tag: 'v2.6.0-beta.1',
        packageVersion: '2.7.0',
        lockVersion: '2.7.0'
      }),
    /package\.json is 2\.7\.0/
  );
  assert.throws(
    () =>
      validateReleaseVersions({
        tag: 'v2.6.0-beta.1',
        packageVersion: '2.6.0',
        lockVersion: '2.5.0'
      }),
    /package-lock\.json is 2\.5\.0/
  );
});

test('release policy accepts a version-synchronised beta tag', () => {
  assert.deepEqual(
    validateReleaseVersions({
      tag: 'v2.6.0-beta.1',
      packageVersion: '2.6.0',
      lockVersion: '2.6.0'
    }),
    {
      tag: 'v2.6.0-beta.1',
      version: '2.6.0',
      prerelease: true,
      prereleaseLabel: 'beta.1'
    }
  );
});
