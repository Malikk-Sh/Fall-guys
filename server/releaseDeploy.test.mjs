import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import buildInfo from './buildInfo.js';

const { buildIdentity } = buildInfo;
const install = readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../deploy/smoke.sh', import.meta.url), 'utf8');
const restore = readFileSync(new URL('../deploy/restore.sh', import.meta.url), 'utf8');
const service = readFileSync(new URL('../deploy/wobble.service', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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

test('production systemd starts the same shadow-preloaded entrypoint as npm start', () => {
  const execStart = service.match(/^ExecStart=(.+)$/m)?.[1];
  assert.ok(execStart, 'wobble.service must define ExecStart');

  // systemd uses the absolute Node path while package.json uses PATH. Everything after that must
  // stay byte-for-byte equivalent, otherwise a production-only startup path can silently omit
  // migration wiring while smoke tests still see a healthy legacy server.
  const normalizedServiceStart = execStart.replace(/^\/usr\/bin\/node\b/, 'node');
  assert.equal(normalizedServiceStart, packageJson.scripts.start);
  assert.match(normalizedServiceStart, /--require \.\/server\/shadowInputPreload\.js/);
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

test('restore protects the requested recovery point before backup retention can run', () => {
  const protect = restore.indexOf(
    'install -o "$APP_USER" -g "$APP_GROUP" -m 0600 "$REQUESTED_BACKUP" "$protected_source"'
  );
  const retentionRun = restore.indexOf('systemctl start wobble-backup.service');
  assert.ok(protect >= 0, 'restore must create a protected source copy');
  assert.ok(
    retentionRun > protect,
    'selected restore point must be protected before retention-producing backup'
  );
  assert.match(restore, /trap cleanup_restore_source EXIT/);
  assert.match(restore, /BACKUP="\$protected_source"/);
});
