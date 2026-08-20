'use strict';

const { C2S, S2C, ROOM_STATE } = require('../shared/protocol.js');
const { validateMessage, RateLimiter } = require('../shared/validation.js');
const { ShadowInputRuntime, SERVER_SIMULATION_INTERVAL_MS } = require('./shadowInputRuntime');

const BRIDGE_KEY = Symbol.for('wobble.shadow-input-bridge');
const SOCKET_KEY = Symbol.for('wobble.shadow-input-listener');
const SEND_KEY = Symbol.for('wobble.shadow-input-send');
const ACTIVE_STATES = new Set([ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING]);
const METRICS_INTERVAL_MS = 60_000;

function createBridge() {
  const runtime = new ShadowInputRuntime();
  const attached = new Map();
  let tickTimer = null;
  let metricsTimer = null;
  let core = null;
  let stopped = false;

  function enrichSnapshotPayload(payload, player, ws) {
    if (typeof payload !== 'string' || !payload.includes('"type":"snapshot"')) return payload;
    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      return payload;
    }
    if (message?.type !== S2C.SNAPSHOT) return payload;

    const currentRoom = core?.rooms.get(ws.room);
    const currentPlayer = currentRoom?.players.get(ws.id);
    if (!currentRoom || !currentPlayer || currentPlayer !== player || currentPlayer.ws !== ws) return payload;
    if (message.matchId !== currentRoom.matchId) return payload;

    const shadow = runtime.snapshot(currentPlayer);
    if (!shadow || shadow.matchId !== message.matchId) return payload;
    return JSON.stringify({
      ...message,
      serverTick: shadow.lastServerTick >= 0 ? shadow.lastServerTick : runtime.serverTick,
      lastProcessedInput: shadow.lastProcessedInput,
      shadowPlayerState: shadow.state
    });
  }

  function attachPlayer(player) {
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

    const originalSend = ws.send;
    const wrappedSend = function shadowAcknowledgedSend(payload, ...args) {
      return originalSend.call(this, enrichSnapshotPayload(payload, player, ws), ...args);
    };
    Object.defineProperty(ws, SOCKET_KEY, { value: true, configurable: true });
    Object.defineProperty(ws, SEND_KEY, { value: originalSend, configurable: true });
    ws.send = wrappedSend;
    ws.on('message', listener);
    attached.set(ws, { listener, originalSend, wrappedSend });
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
        if (!player.bot) attachPlayer(player);
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
    for (const [ws, entry] of attached) {
      ws.off?.('message', entry.listener);
      if (ws.send === entry.wrappedSend) ws.send = entry.originalSend;
      try {
        delete ws[SOCKET_KEY];
        delete ws[SEND_KEY];
      } catch {
        // Socket teardown already owns the object; the markers are only idempotency guards.
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
  if (bridge.started) return;
  const core = require('./index');
  bridge.started = bridge.start(core);
});

module.exports = bridge;
