import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const install = fs.readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const nginx = fs.readFileSync(new URL('../deploy/nginx-locations.conf', import.meta.url), 'utf8');
const unit = fs.readFileSync(new URL('../deploy/wobble-control.service', import.meta.url), 'utf8');

test('existing-production cutover starts Control Plane before Nginx switch and gameplay restart', () => {
  const controlStart = install.indexOf('systemctl restart wobble-control');
  const nginxConfig = install.indexOf('say "Nginx"');
  const gameplayAfterCutover = install.indexOf(
    'say "Перезапуск gameplay после переключения Wobble Control"'
  );
  assert.ok(controlStart >= 0, 'control service start missing');
  assert.ok(nginxConfig > controlStart, 'Nginx cutover must happen after Control Plane is healthy');
  assert.ok(
    gameplayAfterCutover > nginxConfig,
    'normal gameplay restart must happen only after admin routing cutover'
  );

  const freshGuard = install.indexOf(
    'if [ "$database_file" != ":memory:" ] && [ ! -f "$database_file" ]; then'
  );
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

test('Control Plane systemd unit stays independent from gameplay lifecycle', () => {
  assert.doesNotMatch(unit, /^(Requires|PartOf)=wobble\.service$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node server\/controlPlane\.js$/m);
  assert.match(unit, /^Restart=always$/m);
});

test('standard npm test includes every new Control Plane regression file', () => {
  for (const file of [
    'server/controlPlaneGameClient.test.mjs',
    'server/controlPlaneRoutes.test.mjs',
    'server/serviceReliabilityReader.test.mjs',
    'server/controlPlaneDeploy.test.mjs'
  ]) {
    assert.ok(pkg.scripts.test.includes(file), `${file} missing from npm test`);
  }
});
