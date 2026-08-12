from pathlib import Path


def replace_once(path, old, new, label):
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    file.write_text(text.replace(old, new), encoding='utf-8')


# 1. Do not let an in-flight incident search repopulate account-linked DOM after logout/session expiry.
replace_once(
    'client/admin/admin.js',
    """async function searchIncidents() {
  const query = $('#incident-search-query').value.trim();
  if (query.length < 2) {
    $('#incident-search-meta').textContent = 'Введите хотя бы 2 символа.';
    return false;
  }
  state.incidentSearchQuery = query;
  const payload = await api('/api/admin/players/search', { query, limit: 30 });
  const body = $('#incident-results-body');
""",
    """async function searchIncidents() {
  const query = $('#incident-search-query').value.trim();
  if (query.length < 2) {
    $('#incident-search-meta').textContent = 'Введите хотя бы 2 символа.';
    return false;
  }
  const revision = ++state.incidentRevision;
  const sessionGeneration = state.sessionGeneration;
  state.incidentSearchQuery = query;
  const payload = await api('/api/admin/players/search', { query, limit: 30 });
  if (revision !== state.incidentRevision || sessionGeneration !== state.sessionGeneration) return false;
  const body = $('#incident-results-body');
""",
    'incident search async invalidation'
)

# Static client regression belongs next to the incident route contract tests.
replace_once(
    'server/adminIncidentRoutes.test.mjs',
    """import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
""",
    """import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
""",
    'incident route test import'
)
replace_once(
    'server/adminIncidentRoutes.test.mjs',
    """const { installAdminRoutes } = require('./adminRoutes');

async function start(role) {
""",
    """const { installAdminRoutes } = require('./adminRoutes');
const adminClient = readFileSync(new URL('../client/admin/admin.js', import.meta.url), 'utf8');

async function start(role) {
""",
    'incident client fixture'
)
with Path('server/adminIncidentRoutes.test.mjs').open('a', encoding='utf-8') as file:
    file.write("""

test('incident search responses cannot repopulate account data after admin session invalidation', () => {
  const start = adminClient.indexOf('async function searchIncidents()');
  const end = adminClient.indexOf('async function loadIncidents()', start);
  assert.ok(start >= 0 && end > start);
  const source = adminClient.slice(start, end);
  assert.match(source, /const revision = \\+\\+state\\.incidentRevision;/);
  assert.match(source, /const sessionGeneration = state\\.sessionGeneration;/);
  assert.match(
    source,
    /revision !== state\\.incidentRevision \\|\\| sessionGeneration !== state\\.sessionGeneration/
  );
});
""")

# 2. A diagnostic success event must describe a fully completed logout, not a partial cleanup.
replace_once(
    'server/adminControl.js',
    """    try {
      this.incidents?.record({ accountId: id, kind: 'support', code: 'forced-logout', occurredAt: now });
    } catch {
      // Diagnostics are observability only; failure must never weaken or roll back a completed logout.
    }
""",
    """    if (auditedFailedSteps.length === 0) {
      try {
        this.incidents?.record({ accountId: id, kind: 'support', code: 'forced-logout', occurredAt: now });
      } catch {
        // Diagnostics are observability only; failure must never weaken or roll back a completed logout.
      }
    }
""",
    'forced logout incident completion gate'
)

# Give the existing route integration tests an observable diagnostics stub.
replace_once(
    'server/adminPlayerSupportRoutes.test.mjs',
    """  const disconnected = [];
  const reconnectRevocations = [];
  const adminAuth = new AdminAuthService({ db });
""",
    """  const disconnected = [];
  const reconnectRevocations = [];
  const incidentEvents = [];
  const adminAuth = new AdminAuthService({ db });
""",
    'support route incident fixture'
)
replace_once(
    'server/adminPlayerSupportRoutes.test.mjs',
    """    accounts,
    auth,
    disconnectAccount: (accountId, options) => {
""",
    """    accounts,
    auth,
    incidents: {
      record: event => {
        incidentEvents.push(event);
        return true;
      }
    },
    disconnectAccount: (accountId, options) => {
""",
    'support route incident stub'
)
replace_once(
    'server/adminPlayerSupportRoutes.test.mjs',
    """  return { db, adminAuth, app, auth, accounts, disconnected, reconnectRevocations };
""",
    """  return { db, adminAuth, app, auth, accounts, disconnected, reconnectRevocations, incidentEvents };
""",
    'support route fixture return'
)
replace_once(
    'server/adminPlayerSupportRoutes.test.mjs',
    """  const { db, adminAuth, app, auth, disconnected, reconnectRevocations } = prepare();
""",
    """  const { db, adminAuth, app, auth, disconnected, reconnectRevocations, incidentEvents } = prepare();
""",
    'support success test fixture'
)
replace_once(
    'server/adminPlayerSupportRoutes.test.mjs',
    """  assert.equal(disconnected[0].accountId, 'support-player');
  assert.equal(disconnected[0].options.reason, 'support-logout');

  const logoutAudit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
""",
    """  assert.equal(disconnected[0].accountId, 'support-player');
  assert.equal(disconnected[0].options.reason, 'support-logout');
  assert.deepEqual(incidentEvents, [
    {
      accountId: 'support-player',
      kind: 'support',
      code: 'forced-logout',
      occurredAt: incidentEvents[0].occurredAt
    }
  ]);

  const logoutAudit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
""",
    'support success incident assertion'
)
replace_once(
    'server/adminPlayerSupportRoutes.test.mjs',
    """  const { db, adminAuth, app, auth, disconnected, reconnectRevocations } = prepare({
    reconnectFailure: true
  });
""",
    """  const { db, adminAuth, app, auth, disconnected, reconnectRevocations, incidentEvents } = prepare({
    reconnectFailure: true
  });
""",
    'partial logout fixture'
)
replace_once(
    'server/adminPlayerSupportRoutes.test.mjs',
    """  assert.deepEqual(reconnectRevocations, ['support-player']);
  assert.equal(disconnected.length, 1, 'later cleanup steps still run after an earlier local failure');

  const audit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
""",
    """  assert.deepEqual(reconnectRevocations, ['support-player']);
  assert.equal(disconnected.length, 1, 'later cleanup steps still run after an earlier local failure');
  assert.deepEqual(incidentEvents, [], 'partial cleanup must not claim forced-logout completion');

  const audit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
""",
    'partial logout incident assertion'
)
replace_once(
    'server/adminPlayerSupportRoutes.test.mjs',
    """  const { db, adminAuth, app, auth, disconnected, reconnectRevocations } = prepare();
  const { server, base } = await start(app);
  t.after(() => {
""",
    """  const { db, adminAuth, app, auth, disconnected, reconnectRevocations, incidentEvents } = prepare();
  const { server, base } = await start(app);
  t.after(() => {
""",
    'http failure fixture'
)
replace_once(
    'server/adminPlayerSupportRoutes.test.mjs',
    """  assert.deepEqual(reconnectRevocations, ['support-player']);
  assert.equal(disconnected.length, 1, 'all process-local cleanup still runs');

  const audit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
""",
    """  assert.deepEqual(reconnectRevocations, ['support-player']);
  assert.equal(disconnected.length, 1, 'all process-local cleanup still runs');
  assert.deepEqual(incidentEvents, [], 'durable cleanup failure must not claim logout completion');

  const audit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
""",
    'http failure incident assertion'
)

# 3. Preserve the requested restore point outside managed retention before creating a rollback backup.
replace_once(
    'deploy/restore.sh',
    """BACKUP="$(readlink -f "$BACKUP")"

say "Verify requested backup"
/usr/bin/node "$APP_DIR/server/backupCli.mjs" verify "$BACKUP"

# Prepare rollback storage and create a fresh verified snapshot before touching the running service.
mkdir -p "$BACKUP_DIR/restore-rollback"
chown "$APP_USER:$APP_GROUP" "$BACKUP_DIR" "$BACKUP_DIR/restore-rollback"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/restore-rollback"

rollback=""
""",
    """BACKUP="$(readlink -f "$BACKUP")"
REQUESTED_BACKUP="$BACKUP"

say "Verify requested backup"
/usr/bin/node "$APP_DIR/server/backupCli.mjs" verify "$REQUESTED_BACKUP"

# Protect the selected recovery point before creating any new backup. The backup service applies
# retention, so the selected oldest tier file must not remain its deletion target while rollback
# preparation runs.
mkdir -p "$BACKUP_DIR/restore-rollback"
chown "$APP_USER:$APP_GROUP" "$BACKUP_DIR" "$BACKUP_DIR/restore-rollback"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/restore-rollback"
protected_source="$BACKUP_DIR/restore-rollback/.restore-source-$(date -u +%Y%m%dT%H%M%SZ)-$$.db"
cleanup_restore_source() {
  rm -f -- "$protected_source"
}
trap cleanup_restore_source EXIT
if ! install -o "$APP_USER" -g "$APP_GROUP" -m 0600 "$REQUESTED_BACKUP" "$protected_source" ||
  ! /usr/bin/node "$APP_DIR/server/backupCli.mjs" verify "$protected_source"; then
  warn "requested restore point could not be protected before retention"
  exit 1
fi
BACKUP="$protected_source"

# Prepare a fresh verified rollback snapshot before touching the running service.
rollback=""
""",
    'restore source preservation'
)
replace_once(
    'deploy/restore.sh',
    """echo "source backup: $BACKUP"
""",
    """echo "source backup: $REQUESTED_BACKUP"
""",
    'restore source display'
)

# Static deployment regression: protection must happen before the first backup-service activation.
replace_once(
    'server/releaseDeploy.test.mjs',
    """const install = readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../deploy/smoke.sh', import.meta.url), 'utf8');
""",
    """const install = readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../deploy/smoke.sh', import.meta.url), 'utf8');
const restore = readFileSync(new URL('../deploy/restore.sh', import.meta.url), 'utf8');
""",
    'restore deployment fixture'
)
with Path('server/releaseDeploy.test.mjs').open('a', encoding='utf-8') as file:
    file.write("""

test('restore protects the requested recovery point before backup retention can run', () => {
  const protect = restore.indexOf('install -o "$APP_USER" -g "$APP_GROUP" -m 0600 "$REQUESTED_BACKUP" "$protected_source"');
  const retentionRun = restore.indexOf('systemctl start wobble-backup.service');
  assert.ok(protect >= 0, 'restore must create a protected source copy');
  assert.ok(retentionRun > protect, 'selected restore point must be protected before retention-producing backup');
  assert.match(restore, /trap cleanup_restore_source EXIT/);
  assert.match(restore, /BACKUP="\\$protected_source"/);
});
""")
