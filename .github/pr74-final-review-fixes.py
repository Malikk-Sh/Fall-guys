from pathlib import Path
import re


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    return text.replace(old, new, 1)


# FIND_COOP must stop at the drain gate before capacity metrics can change.
index_path = Path('server/index.js')
index = index_path.read_text()
index = replace_once(
    index,
    """    if (message.type === C2S.FIND_COOP) {
      if (loadStatus().overloaded || rooms.size >= MAX_ROOMS) {
""",
    """    if (message.type === C2S.FIND_COOP) {
      if (operationalState.isDraining()) {
        return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      }
      if (loadStatus().overloaded || rooms.size >= MAX_ROOMS) {
""",
    'FIND_COOP early drain guard'
)

# Core owns the process-wide drain transition because it also owns matchmaking and WebSockets.
enqueue_pattern = re.compile(r"(function enqueueCoop\(ws, message\) \{[\s\S]*?\n\})\n\n(?=// Возврат|function )")
match = enqueue_pattern.search(index)
if not match:
    raise SystemExit('enqueueCoop function boundary not found')
drain_fn = """

function beginOperationalDrain() {
  if (!operationalState.beginDrain()) return false;

  // No queued player can ever be matched after admission closes. Remove the impossible queue
  // immediately and record the exit without counting it as a capacity rejection.
  const queued = coopMatchmaking.splice(0);
  for (const entry of queued) {
    gameplay.count('matchmaking_queue_exit', {
      detail: 'restart',
      device: entry.ws?.device || 'desktop'
    });
  }

  // core.shutdown broadcasts only to room players. Roomless sockets (including matchmaking) must
  // learn about maintenance now instead of waiting up to the match-drain deadline for a generic
  // network close.
  for (const client of wss.clients) {
    if (!client.room && canSend(client)) {
      send(client, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
    }
  }
  return true;
}
"""
index = index[:match.end()] + drain_fn + index[match.end():]
index = replace_once(
    index,
    """  socialSafety,
  coopMatchCompatible,
  leave,
""",
    """  socialSafety,
  coopMatchCompatible,
  beginOperationalDrain,
  leave,
""",
    'beginOperationalDrain export'
)
index_path.write_text(index)


# Bootstrap delegates the atomic drain transition to core, then only waits for active matches.
bootstrap_path = Path('server/bootstrap.js')
bootstrap = bootstrap_path.read_text()
bootstrap = replace_once(
    bootstrap,
    "const operationalState = require('./operationalState');\n",
    '',
    'remove bootstrap operationalState import'
)
bootstrap = replace_once(
    bootstrap,
    """  // `operationalState` — один экземпляр CommonJS-модуля для bootstrap и index.js. Поэтому в тот
  // же тик, когда SIGUSR2 начинает drain, центральный beginCountdown() перестаёт принимать любые
  // новые старты: host start, matchmaking, rematch и next chapter используют один admission gate.
  if (!operationalState.beginDrain()) return false;
""",
    """  // Core owns the process-wide drain transition: in the same tick it closes new admission,
  // clears impossible matchmaking waits and notifies roomless sockets. Active room sockets stay
  // connected while bootstrap waits for COUNTDOWN/PLAYING matches to finish.
  if (!core.beginOperationalDrain()) return false;
""",
    'bootstrap drain entrypoint'
)
bootstrap_path.write_text(bootstrap)


# Restart recovery retries a signal-pending marker on later bounded monitor ticks after transient
# health/systemd misses, rather than trying only once at helper startup.
helper_path = Path('deploy/wobble-ops-helper.mjs')
helper = helper_path.read_text()
confirm_fn = """async function confirmOldProcessNotDraining(oldPid) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const health = await readWobbleOperationalHealth();
    const pid = await wobbleMainPid();
    if (!health || health.pid !== oldPid || health.draining || pid !== oldPid) return false;
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return true;
}
"""
advance_fn = confirm_fn + """

async function advancePendingRestartSignal(marker, markerPath = RESTART_MARKER) {
  if (!marker || marker.phase !== 'signal-pending') return { marker, rolledBack: false };

  const pid = await wobbleMainPid();
  const health = await readWobbleOperationalHealth();
  const confirmedPid = await wobbleMainPid();

  if (pid === marker.oldPid && confirmedPid === marker.oldPid && health?.pid === marker.oldPid) {
    if (health.draining === true) {
      marker = { ...marker, phase: 'signal-delivered' };
      writeRestartMarker(marker, markerPath);
      return { marker, rolledBack: false };
    }

    const signal = await sendGracefulRestartSignal();
    if (signal.ok) {
      marker = { ...marker, phase: 'signal-delivered' };
      writeRestartMarker(marker, markerPath);
      return { marker, rolledBack: false };
    }
    if (signal.reason === 'operation-timeout') {
      marker = { ...marker, phase: 'signal-uncertain' };
      writeRestartMarker(marker, markerPath);
      return { marker, rolledBack: false };
    }

    const safeToRollback = await confirmOldProcessNotDraining(marker.oldPid);
    if (safeToRollback) {
      clearRestartMarker(markerPath);
      if (marker.clearMaintenance) setMaintenance(false);
      restartInFlight = false;
      return { marker: null, rolledBack: true };
    }

    marker = { ...marker, phase: 'signal-uncertain' };
    writeRestartMarker(marker, markerPath);
    return { marker, rolledBack: false };
  }

  if (pid && pid !== marker.oldPid && confirmedPid === pid) {
    // The replacement is already the MainPID. Never send SIGUSR2 to the fresh process.
    marker = { ...marker, phase: 'signal-delivered' };
    writeRestartMarker(marker, markerPath);
  }

  // Missing/discordant PID or health is transient/ambiguous: keep signal-pending. The bounded
  // monitor will retry this exact state on a later tick while maintenance stays fail-closed.
  return { marker, rolledBack: false };
}
"""
helper = replace_once(helper, confirm_fn, advance_fn, 'advancePendingRestartSignal insertion')

monitor_anchor = """      if (!maintenanceEnabled()) setMaintenance(true);

      const pid = await wobbleMainPid();
"""
monitor_replacement = """      if (!maintenanceEnabled()) setMaintenance(true);

      const persisted = readRestartMarker(markerPath);
      if (persisted?.phase === 'signal-pending') {
        const advanced = await advancePendingRestartSignal(persisted, markerPath);
        if (advanced.rolledBack) {
          clearInterval(timer);
          return;
        }
      }

      const pid = await wobbleMainPid();
"""
helper = replace_once(helper, monitor_anchor, monitor_replacement, 'pending retry in monitor')

pending_pattern = re.compile(
    r"  if \(marker\.phase === 'signal-pending'\) \{[\s\S]*?\n  \}\n\n  scheduleRestartCompletion\(marker\.oldPid, \{",
    re.M
)
pending_replacement = """  if (marker.phase === 'signal-pending') {
    const advanced = await advancePendingRestartSignal(marker, markerPath);
    if (advanced.rolledBack) return false;
    marker = advanced.marker || marker;
  }

  scheduleRestartCompletion(marker.oldPid, {"""
helper, count = pending_pattern.subn(pending_replacement, helper, count=1)
if count != 1:
    raise SystemExit(f'recover pending block: expected 1 match, got {count}')
helper_path.write_text(helper)


# Focused static regression coverage complements the existing behavioral operation tests.
test_path = Path('server/adminOperations.test.mjs')
tests = test_path.read_text()
tests = replace_once(
    tests,
    "  assert.match(bootstrap, /operationalState\\.beginDrain\\(\\)/);\n",
    "  assert.match(bootstrap, /core\\.beginOperationalDrain\\(\\)/);\n",
    'bootstrap drain assertion'
)

insert_after = """  assert.ok(startHandlerAt >= 0 && startDrainAt > startHandlerAt && startDrainAt < capacityAt);
  assert.ok(capacityAt < capacityMetricAt);
"""
find_assertions = insert_after + """

  const findHandlerAt = index.indexOf('if (message.type === C2S.FIND_COOP)');
  const findDrainAt = index.indexOf('if (operationalState.isDraining())', findHandlerAt);
  const findCapacityAt = index.indexOf('if (loadStatus().overloaded || rooms.size >= MAX_ROOMS)', findHandlerAt);
  const findCapacityMetricAt = index.indexOf('metrics.capacityRejected++', findHandlerAt);
  assert.ok(findHandlerAt >= 0 && findDrainAt > findHandlerAt && findDrainAt < findCapacityAt);
  assert.ok(findCapacityAt < findCapacityMetricAt);
"""
tests = replace_once(tests, insert_after, find_assertions, 'FIND_COOP ordering assertions')

recovery_old = """  const recoveryAt = helper.indexOf('export async function recoverRestartMonitor');
  const pendingRecoveryAt = helper.indexOf("marker.phase === 'signal-pending'", recoveryAt);
  const recoverySignalAt = helper.indexOf('await sendGracefulRestartSignal()', pendingRecoveryAt);
  const recoveryMonitorAt = helper.indexOf('scheduleRestartCompletion(marker.oldPid', recoveryAt);
  assert.ok(
    recoveryAt >= 0 &&
      pendingRecoveryAt > recoveryAt &&
      recoverySignalAt > pendingRecoveryAt &&
      recoverySignalAt < recoveryMonitorAt
  );
  assert.match(helper, /await recoverRestartMonitor\\(\\);/);
"""
recovery_new = """  const advanceAt = helper.indexOf('async function advancePendingRestartSignal');
  const recoveryAt = helper.indexOf('export async function recoverRestartMonitor');
  const recoveryAdvanceAt = helper.indexOf('await advancePendingRestartSignal(marker, markerPath)', recoveryAt);
  const recoveryMonitorAt = helper.indexOf('scheduleRestartCompletion(marker.oldPid', recoveryAt);
  const completionAt = helper.indexOf('function scheduleRestartCompletion');
  const persistedPendingAt = helper.indexOf("persisted?.phase === 'signal-pending'", completionAt);
  const monitorAdvanceAt = helper.indexOf('await advancePendingRestartSignal(persisted, markerPath)', persistedPendingAt);
  assert.ok(advanceAt >= 0 && recoveryAdvanceAt > recoveryAt && recoveryAdvanceAt < recoveryMonitorAt);
  assert.ok(completionAt >= 0 && persistedPendingAt > completionAt && monitorAdvanceAt > persistedPendingAt);
  assert.match(helper, /await recoverRestartMonitor\\(\\);/);
"""
tests = replace_once(tests, recovery_old, recovery_new, 'pending recovery retry assertions')

queue_anchor = """  const enqueueAt = index.indexOf('function enqueueCoop(ws, message)');
"""
queue_assertions = """  const drainFnAt = index.indexOf('function beginOperationalDrain()');
  const queueClearAt = index.indexOf('coopMatchmaking.splice(0)', drainFnAt);
  const roomlessClientsAt = index.indexOf('for (const client of wss.clients)', drainFnAt);
  const roomlessShutdownAt = index.indexOf('S2C.SERVER_SHUTDOWN', roomlessClientsAt);
  assert.ok(drainFnAt >= 0 && queueClearAt > drainFnAt && roomlessClientsAt > queueClearAt);
  assert.ok(roomlessShutdownAt > roomlessClientsAt);

""" + queue_anchor
tests = replace_once(tests, queue_anchor, queue_assertions, 'roomless drain assertions')
test_path.write_text(tests)
