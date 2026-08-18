import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { expandNpmScript } from './testScriptGraph.mjs';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const install = fs.readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const nginx = fs.readFileSync(new URL('../deploy/nginx-locations.conf', import.meta.url), 'utf8');
const unit = fs.readFileSync(new URL('../deploy/wobble-control.service', import.meta.url), 'utf8');
const telegramUnit = fs.readFileSync(
  new URL('../deploy/wobble-telegram-alerts.service', import.meta.url),
  'utf8'
);
const telegramEnvExample = fs.readFileSync(
  new URL('../deploy/wobble-telegram.env.example', import.meta.url),
  'utf8'
);

test('existing-production cutover starts Control Plane before Nginx switch and gameplay restart', () => {
  const controlStart = install.indexOf('systemctl restart wobble-control');
  const nginxConfig = install.indexOf('say "Nginx"');
  const gameplayAfterCutover = install.indexOf('say "Перезапуск gameplay после переключения Wobble Control"');
  assert.ok(controlStart >= 0, 'control service start missing');
  assert.ok(nginxConfig > controlStart, 'Nginx cutover must happen after Control Plane is healthy');
  assert.ok(
    gameplayAfterCutover > nginxConfig,
    'normal gameplay restart must happen only after admin routing cutover'
  );

  const freshGuard = install.indexOf('if [ ! -f "$database_file" ]; then');
  const freshBootstrap = install.indexOf('systemctl restart wobble', freshGuard);
  assert.ok(freshGuard >= 0 && freshBootstrap > freshGuard && freshBootstrap < controlStart);
});

test('Nginx keeps lowercase admin routes on Control Plane and rejects case variants', () => {
  assert.match(nginx, /location \^~ \/api\/admin\/ \{/);
  assert.match(nginx, /location \^~ \/admin\/ \{/);
  assert.match(nginx, /location ~\* \^\/api\/admin\(\?:\/\|\$\) \{\s*return 404;/);
  assert.match(nginx, /location ~\* \^\/admin\(\?:\/\|\$\) \{\s*return 404;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3001;/);
});

test('Control Plane requires the shared persistent production database', () => {
  const control = fs.readFileSync(new URL('./controlPlane.js', import.meta.url), 'utf8');
  assert.match(control, /databaseFile === ':memory:'[\s\S]*requires a shared persistent LEADERBOARD_DB/);
  assert.match(install, /Wobble Control требует общий persistent LEADERBOARD_DB/);
});

test('Control Plane systemd unit stays independent from gameplay lifecycle', () => {
  assert.doesNotMatch(unit, /^(Requires|PartOf)=wobble\.service$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node server\/controlPlane\.js$/m);
  assert.match(unit, /^Restart=always$/m);
});

test('standard npm test includes every new Control Plane regression file', () => {
  const standardTest = expandNpmScript(pkg.scripts, 'test');
  for (const file of [
    'server/controlPlaneGameClient.test.mjs',
    'server/controlPlaneRoutes.test.mjs',
    'server/serviceReliabilityReader.test.mjs',
    'server/controlPlaneAlerts.test.mjs',
    'server/telegramAlertDelivery.test.mjs',
    'server/controlPlaneDeploy.test.mjs'
  ]) {
    assert.ok(standardTest.includes(file), `${file} missing from npm test`);
  }
});

test('Control Plane owns a separate persistent Alert Center state directory and lifecycle', () => {
  const control = fs.readFileSync(new URL('./controlPlane.js', import.meta.url), 'utf8');
  assert.match(unit, /^StateDirectory=wobble-control$/m);
  assert.match(unit, /^StateDirectoryMode=0750$/m);
  assert.match(unit, /^Environment=CONTROL_ALERT_STATE=\/var\/lib\/wobble-control\/alerts\.json$/m);
  assert.match(control, /new ControlPlaneAlertCenter\(\{ infrastructure, reliability, operations \}\)/);
  assert.match(control, /alerts\.start\(\);/);
  assert.match(control, /alerts\.stop\(\);/);
});

test('Telegram delivery is a separate DynamicUser service with an independent secret and state boundary', () => {
  assert.match(telegramUnit, /^DynamicUser=yes$/m);
  assert.match(telegramUnit, /^EnvironmentFile=\/etc\/wobble-telegram\.env$/m);
  assert.match(telegramUnit, /^StateDirectory=wobble-telegram-alerts$/m);
  assert.match(telegramUnit, /^StateDirectoryMode=0700$/m);
  assert.match(telegramUnit, /^RestartPreventExitStatus=78$/m);
  assert.doesNotMatch(telegramUnit, /^User=(root|wobble)$/m);
  assert.doesNotMatch(telegramUnit, /wobble-ops\.sock/);
  assert.doesNotMatch(telegramUnit, /LEADERBOARD_DB/);
  assert.match(telegramEnvExample, /^TELEGRAM_ALERTS_ENABLED=0$/m);
  assert.match(telegramEnvExample, /^TELEGRAM_BOT_TOKEN=$/m);
  assert.match(telegramEnvExample, /^TELEGRAM_CHAT_ID=$/m);
});

test('installer never overwrites Telegram secrets and does not make notifier health a deploy dependency', () => {
  assert.match(install, /if \[ ! -f "\$telegram_env" \]; then[\s\S]*wobble-telegram\.env\.example/);
  assert.match(install, /chmod 600 "\$telegram_env"/);
  assert.match(install, /TELEGRAM_ALERTS_ENABLED=1/);
  assert.match(install, /systemctl enable wobble-telegram-alerts/);
  assert.match(install, /systemctl disable wobble-telegram-alerts/);
  assert.match(install, /Telegram notifier не запущен; основной deploy продолжается независимо/);
  assert.doesNotMatch(install, /TELEGRAM_BOT_TOKEN=.*\/etc\/wobble\.env/);
});

test('Control Plane exposes only the sanitized Telegram feed on its fixed loopback service', () => {
  const control = fs.readFileSync(new URL('./controlPlane.js', import.meta.url), 'utf8');
  assert.match(control, /app\.get\('\/internal\/alerts\/delivery'/);
  assert.match(control, /isLoopbackAddress\(req\.socket\.remoteAddress\)/);
  assert.match(control, /buildAlertDeliveryFeed\(alerts\.status\(\)\)/);
});
