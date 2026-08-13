import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const install = fs.readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const unit = fs.readFileSync(
  new URL('../deploy/wobble-telegram-alert-test.service', import.meta.url),
  'utf8'
);

test('Telegram one-shot verification unit has the same isolated secret/egress boundary', () => {
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^DynamicUser=yes$/m);
  assert.match(unit, /^EnvironmentFile=\/etc\/wobble-telegram\.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node server\/telegramAlertTest\.js$/m);
  assert.doesNotMatch(unit, /wobble-ops\.sock/);
  assert.doesNotMatch(unit, /LEADERBOARD_DB/);
  assert.doesNotMatch(unit, /^User=(root|wobble)$/m);
});

test('installer installs but never enables the Telegram one-shot verification unit', () => {
  assert.match(
    install,
    /cp "\$APP_DIR\/deploy\/wobble-telegram-alert-test\.service" \/etc\/systemd\/system\/wobble-telegram-alert-test\.service/
  );
  assert.doesNotMatch(install, /systemctl enable wobble-telegram-alert-test/);
});

test('standard npm test includes all Telegram delivery regressions', () => {
  for (const file of [
    'server/telegramAlertDelivery.test.mjs',
    'server/telegramAlertTest.test.mjs',
    'server/telegramAlertProduction.test.mjs'
  ]) {
    assert.ok(pkg.scripts.test.includes(file), `${file} missing from npm test`);
  }
});
