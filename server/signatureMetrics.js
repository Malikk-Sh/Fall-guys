'use strict';

function stateFor(room) {
  if (!room.signatureMetricsState || room.signatureMetricsState.matchId !== room.matchId) {
    room.signatureMetricsState = {
      matchId: room.matchId,
      coreStartedAt: null,
      signalStartedAt: null,
      signalSolved: false
    };
  }
  return room.signatureMetricsState;
}

function trackSignatureMetrics({ room, player, message, result, gameplay, dimensions, now = Date.now() } = {}) {
  if (!room || !result?.ok || !result.relay?.signature || !gameplay || typeof dimensions !== 'function') {
    return false;
  }

  const command = String(message?.objectId || '');
  if (!/^(core|signal):/.test(command)) return false;

  const state = stateFor(room);
  const detail = command.startsWith('core:') ? 'energy_core' : 'signal_console';
  const dims = dimensions(room, player, detail);

  if (command === 'core:pickup') {
    gameplay.count('core_pickup', dims);
    if (state.coreStartedAt == null) state.coreStartedAt = now;
    return true;
  }

  if (command === 'core:throw') {
    gameplay.count('core_throw', dims);
    return true;
  }

  if (command === 'core:reset') {
    gameplay.count('core_reset', dims);
    state.coreStartedAt = null;
    return true;
  }

  if (command === 'core:insert') {
    gameplay.count('core_insert', dims);
    if (state.coreStartedAt != null) gameplay.observe('core_time_to_insert', now - state.coreStartedAt, dims);
    state.coreStartedAt = null;
    return true;
  }

  if (!command.startsWith('signal:press:')) return false;
  if (state.signalStartedAt == null) state.signalStartedAt = now;

  const signal = result.relay.signature.signal;
  if (!signal) return false;

  if (!signal.solved && signal.progress === 0) {
    gameplay.count('signal_wrong_press', dims);
    gameplay.count('signal_reset', dims);
  }

  if (signal.solved && !state.signalSolved) {
    gameplay.count('signal_solved', dims);
    if (state.signalStartedAt != null) gameplay.observe('signal_solve_ms', now - state.signalStartedAt, dims);
    state.signalSolved = true;
  }

  return true;
}

module.exports = { trackSignatureMetrics };
