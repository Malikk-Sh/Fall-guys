import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import buildInfo from './buildInfo.js';

const { buildIdentity } = buildInfo;
const install = readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../deploy/smoke.sh', import.meta.url), 'utf8');

test('production installer can pin and persist an exact release tag', () => {
  assert.match(install, /RELEASE_TAG="\$\{RELEASE_TAG-\$\{SAVED_RELEASE_TAG:-\}\}"/);
  assert.match(install, /refs\/wobble-release-candidates\/\$\{RELEASE_TAG\}/);
  assert.match(install, /remote_release_object/);
  assert.match(install, /local_release_object/);
  assert.match(install, /release tag \$\{RELEASE_TAG\} изменился/);
  assert.match(install, /checkout --detach --force "\$release_commit"/);
  assert.match(install, /releases\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(install, /release \$\{RELEASE_TAG\} ещё не опубликован/);
  assert.match(install, /check-release\.mjs" "\$RELEASE_TAG"/);
  assert.match(install, /SAVED_RELEASE_TAG='\$\{RELEASE_TAG\}'/);
});

test('deploy smoke can require the exact version, commit and release identity', () => {
  assert.match(smoke, /SMOKE_EXPECT_VERSION/);
  assert.match(smoke, /SMOKE_EXPECT_COMMIT/);
  assert.match(smoke, /SMOKE_EXPECT_RELEASE/);
  assert.match(smoke, /health\.release !== expectedRelease/);
});

test('build identity exposes a release tag only when production supplies one', () => {
  const plain = buildIdentity({ env: { WOBBLE_BUILD_SHA: 'abcdef0123456789' }, startedAt: 'now' });
  assert.equal(Object.hasOwn(plain, 'release'), false);
  const tagged = buildIdentity({
    env: { WOBBLE_BUILD_SHA: 'abcdef0123456789', WOBBLE_RELEASE_TAG: 'v2.6.0-beta.1' },
    startedAt: 'now'
  });
  assert.equal(tagged.release, 'v2.6.0-beta.1');
  assert.equal(tagged.commit, 'abcdef012345');
});
