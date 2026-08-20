'use strict';

const { C2S, ROOM_STATE } = require('../shared/protocol.js');
const { validateMessage, RateLimiter } = require('../shared/validation.js');
const { ShadowInputRuntime, SERVER_SIMULATION_INTERVAL_MS } = require('./shadowInputRuntime');

const BRIDGE_KEY = Symbol.for('wobble.shadow-input-bridge');
const SOCKET_KEY = Symbol.for('wobble.shadow-input-listener');
const ACTIVE_STATES = new Set([ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING]);
const METRICS_INTERVAL_MS = 60_000;

function createBridge() {
  const runtime = new ShadowInputRuntime();
  const attached = new Map();
  let tickTimer = null;
  let metricsTimer = null;
  let core = null;
  let stopped = false;

  function attachPlayer(player, room) {
    const ws = player?.ws;
    if (!ws || ws[SOCKET_KEY] || typeof ws.on !== 'function') return false;
    const limiter = new RateLimiter();
    const listener = raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message?.type !== C2S.CLIENT_INPUT) return;
      const validation = validateMessage(message);
      if (!validation.ok || !limiter.allow(C2S.CLIENT_INPUT)) return;
      const currentRoom = core?.rooms.get(ws.room);
      const currentPlayer = currentRoom?.players.get(ws.id);
      if (!currentRoom || !currentPlayer || currentPlayer !== player || currentPlayer.ws !== ws) return;
      if (!ACTIVE_STATES.has(currentRoom.state) || message.matchId !== currentRoom.matchId) return;
      runtime.accept({ player: currentPlayer, room: currentRoom, message });
    };
    Object.defineProperty(ws, SOCKET_KEY, { value: true, configurable: true });
    ws.on('message', listener);
    attached.set(ws, listener);
    ws.once('close', () => {
      attached.delete(ws);
    });
    return true;
  }

  function scan() {
    if (!core) return;
    for (const room of core.rooms.values()) {
      if (!ACTIVE_STATES.has(room.state)) continue;
      for (const player of room.players.values()) {
        if (!player.bot) attachPlayer(player, room);
      }
    }
  }

  function tick() {
    if (!core || stopped) return;
    scan();
    runtime.tick(core.rooms);
  }

  function logMetrics() {
    const metrics = runtime.metrics();
    if (!metrics.accepted && !Object.values(metrics.rejected).some(Boolean)) return;
    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        event: 'shadow_simulation_metrics',
        ts: new Date().toISOString(),
        ...metrics
      })}\n`
    );
  }

  function start(nextCore) {
    if (core || stopped) return false;
    core = nextCore;
    scan();
    tickTimer = setInterval(tick, SERVER_SIMULATION_INTERVAL_MS);
    tickTimer.unref?.();
    metricsTimer = setInterval(logMetrics, METRICS_INTERVAL_MS);
    metricsTimer.unref?.();
    core.server.once('close', stop);
    return true;
  }

  function stop() {
    if (stopped) return false;
    stopped = true;
    clearInterval(tickTimer);
    clearInterval(metricsTimer);
    for (const [ws, listener] of attached) {
      ws.off?.('message', listener);
      try {
        delete ws[SOCKET_KEY];
      } catch {
        // Socket teardown already owns the object; the marker is only an idempotency guard.
      }
    }
    attached.clear();
    return true;
  }

  return { runtime, start, stop, scan, attachedCount: () => attached.size };
}

const bridge = globalThis[BRIDGE_KEY] || createBridge();
globalThis[BRIDGE_KEY] = bridge;

setImmediate(() => {
  if (bridge.started || bridge.stopped) return;
  const core = require('./index');
  bridge.started = bridge.start(core);
});

module.exports = bridge;
