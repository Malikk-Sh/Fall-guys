import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import buildInfo from './buildInfo.js';

const { buildIdentity } = buildInfo;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const install = readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../deploy/smoke.sh', import.meta.url), 'utf8');
const restore = readFileSync(new URL('../deploy/restore.sh', import.meta.url), 'utf8');
const service = readFileSync(new URL('../deploy/wobble.service', import.meta.url), 'utf8');

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

test('production systemd uses the loader-safe shadow preload', () => {
  const execStart = service.match(/^ExecStart=(.+)$/m)?.[1];
  assert.ok(execStart, 'wobble.service must define ExecStart');
  assert.equal(
    execStart,
    '/usr/bin/node --require ./server/productionShadowPreload.js server/bootstrap.js'
  );
});

test('production shadow preload survives synchronous server startup and loads bot modules', () => {
  const script = [
    "const roomBots = require('./server/roomBots');",
    "require('./server/index.js');",
    'roomBots.preloadBots().then(',
    '  () => process.exit(0),',
    '  error => { console.error(error); process.exit(1); }',
    ');'
  ].join('\n');
  const result = spawnSync(
    process.execPath,
    ['--require', './server/productionShadowPreload.js', '-e', script],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, NODE_ENV: 'test', LEADERBOARD_DB: ':memory:' }
    }
  );

  assert.equal(
    result.status,
    0,
    `production preload child failed: ${result.error?.message || result.stderr || result.stdout}`
  );
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
