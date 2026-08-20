'use strict';

const { C2S, S2C, ROOM_STATE } = require('../shared/protocol.js');
const { validateMessage, RateLimiter } = require('../shared/validation.js');
const { SERVER_SIMULATION_INTERVAL_MS } = require('./shadowInputRuntime');
const shadowRuntimeService = require('./shadowRuntimeService');
const shadowRaceAuthorityService = require('./shadowRaceAuthorityService');
const raceProgressAuthorityBoundaryProbe = require('./raceProgressAuthorityBoundaryProbe');
const raceProgressAuthorityBoundaryVerification = require('./raceProgressAuthorityBoundaryVerification');
const raceCheckpointAuthorityApplier = require('./raceCheckpointAuthorityApplier');

const BRIDGE_KEY = Symbol.for('wobble.shadow-input-bridge');
const SOCKET_KEY = Symbol.for('wobble.shadow-input-listener');
const SEND_KEY = Symbol.for('wobble.shadow-input-send');
const ACTIVE_STATES = new Set([ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING]);
const METRICS_INTERVAL_MS = 60_000;

function createBridge() {
  const runtime = shadowRuntimeService.runtime;
  const authorityService = shadowRaceAuthorityService;
  const authorityBoundaryProbe = raceProgressAuthorityBoundaryProbe;
  const authorityBoundaryVerification = raceProgressAuthorityBoundaryVerification;
  const checkpointAuthorityApplier = raceCheckpointAuthorityApplier;
  const attached = new Map();
  let tickTimer = null;
  let metricsTimer = null;
  let core = null;
  let stopped = false;

  function currentPlayerFor(player, ws) {
    const room = core?.rooms.get(ws.room);
    const currentPlayer = room?.players.get(ws.id);
    if (!room || !currentPlayer || currentPlayer !== player || currentPlayer.ws !== ws) return null;
    return { room, player: currentPlayer };
  }

  function observeCoreOutcomePayload(payload, player, ws) {
    if (typeof payload !== 'string') return;
    const isFinishOutcome =
      payload.includes(`"type":"${S2C.PLAYER_FINISHED}"`) ||
      payload.includes(`"type":"${S2C.FINISH_REJECTED}"`);
    if (!isFinishOutcome) return;

    const current = currentPlayerFor(player, ws);
    if (!current) return;
    try {
      authorityBoundaryVerification.observeOutcomePayload({
        payload,
        room: current.room,
        player: current.player
      });
    } catch {
      // Verification is diagnostic-only and must never block the actual finish payload.
    }
    try {
      authorityService.observeOutcomePayload({
        payload,
        room: current.room,
        player: current.player,
        runtimeService: shadowRuntimeService
      });
    } catch {
      // Readiness/probe diagnostics must fail open to the already-produced core finish outcome.
    }
  }

  function enrichSnapshotPayload(payload, player, ws) {
    if (typeof payload !== 'string' || !payload.includes('"type":"snapshot"')) return payload;
    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      return payload;
    }
    if (message?.type !== S2C.SNAPSHOT) return payload;

    const current = currentPlayerFor(player, ws);
    if (!current || message.matchId !== current.room.matchId) return payload;

    const shadow = shadowRuntimeService.snapshot(current.player);
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
    if (!ws || ws[SOCKET_KEY] || typeof ws.on !== 'function' || typeof ws.prependListener !== 'function')
      return false;
    const limiter = new RateLimiter();
    let observedMatchId = null;
    let lastObservedLegacySequence = -1;

    const authorityListener = raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message?.type !== C2S.PLAYER_STATE && message?.type !== C2S.FINISH) return;
      const validation = validateMessage(message);
      if (!validation.ok) return;

      const current = currentPlayerFor(player, ws);
      if (!current || !ACTIVE_STATES.has(current.room.state)) return;
      if (message.matchId && message.matchId !== current.room.matchId) return;

      // prependListener places this probe before the core socket listener. It can therefore
      // exercise the same authority selector with a projected legacy outcome before core mutates
      // player.checkpoint/player.finished. The result remains diagnostic-only, and the verifier
      // later checks that this projection exactly matches the real legacy core outcome.
      try {
        const probeResult = authorityBoundaryProbe.observe({
          message,
          room: current.room,
          player: current.player
        });
        authorityBoundaryVerification.remember({
          message,
          room: current.room,
          player: current.player,
          probeResult
        });
      } catch {
        // Diagnostic-only migration seam: fail open to the unchanged legacy core path.
      }
    };

    const listener = raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message?.type !== C2S.CLIENT_INPUT && message?.type !== C2S.PLAYER_STATE) return;
      const validation = validateMessage(message);
      if (!validation.ok) return;

      const current = currentPlayerFor(player, ws);
      if (!current || !ACTIVE_STATES.has(current.room.state)) return;
      if (message.matchId && message.matchId !== current.room.matchId) return;

      if (message.type === C2S.CLIENT_INPUT) {
        if (!limiter.allow(C2S.CLIENT_INPUT)) return;
        if (message.matchId !== current.room.matchId) return;
        shadowRuntimeService.accept({ player: current.player, room: current.room, message });
        return;
      }

      // The core socket listener is registered when the connection is created; this migration
      // listener is attached only after the player enters an active room. EventEmitter preserves
      // that registration order, so lastSequence here is the outcome of the core validation path.
      if (observedMatchId !== current.room.matchId) {
        observedMatchId = current.room.matchId;
        lastObservedLegacySequence = -1;
      }
      if (message.sequence !== current.player.lastSequence) return;
      if (message.sequence <= lastObservedLegacySequence) return;
      lastObservedLegacySequence = message.sequence;

      let verificationObserved = false;
      try {
        authorityBoundaryVerification.observeAcceptedState({
          message,
          room: current.room,
          player: current.player
        });
        verificationObserved = true;
      } catch {
        // Post-core verification must not turn diagnostics into a transport failure.
      }

      let readinessObserved = false;
      try {
        authorityService.observeAcceptedState({
          message,
          room: current.room,
          player: current.player,
          runtimeService: shadowRuntimeService
        });
        readinessObserved = true;
      } catch {
        // Readiness/probe diagnostics remain fail-open to the accepted legacy state.
      }

      if (!verificationObserved || !readinessObserved) return;
      try {
        checkpointAuthorityApplier.apply({
          room: current.room,
          player: current.player,
          now: Date.now()
        });
      } catch {
        // The optional checkpoint cutover must always fail open to the accepted legacy checkpoint.
      }
    };

    const originalSend = ws.send;
    const wrappedSend = function shadowAcknowledgedSend(payload, ...args) {
      // PLAYER_FINISHED and FINISH_REJECTED are emitted only after core has made its legacy
      // authority decision. Reading that outcome here cannot alter the decision or its payload.
      observeCoreOutcomePayload(payload, player, ws);
      return originalSend.call(this, enrichSnapshotPayload(payload, player, ws), ...args);
    };
    Object.defineProperty(ws, SOCKET_KEY, { value: true, configurable: true });
    Object.defineProperty(ws, SEND_KEY, { value: originalSend, configurable: true });
    ws.send = wrappedSend;
    ws.prependListener('message', authorityListener);
    ws.on('message', listener);
    attached.set(ws, { authorityListener, listener, originalSend, wrappedSend });
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
    shadowRuntimeService.tick(core.rooms);
  }

  function logMetrics() {
    const metrics = shadowRuntimeService.metrics();
    const authorityBoundary = authorityBoundaryProbe.metrics();
    const checkpointAuthority = checkpointAuthorityApplier.metrics();
    const { coreProgress, authorityVerification, authorityReadiness, authorityProbe } =
      authorityService.metrics();
    const hasSimulationTraffic = metrics.accepted || Object.values(metrics.rejected).some(Boolean);
    if (!hasSimulationTraffic && !coreProgress.boundarySamples && !authorityBoundary.samples) return;
    process.stdout.write(
      `${JSON.stringify({
        level: 'info',
        event: 'shadow_simulation_metrics',
        ts: new Date().toISOString(),
        ...metrics,
        coreProgress,
        authorityReadiness,
        authorityProbe,
        authorityBoundary,
        authorityBoundaryVerification: authorityVerification,
        checkpointAuthority
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
      ws.off?.('message', entry.authorityListener);
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

  return {
    runtime,
    runtimeService: shadowRuntimeService,
    authorityService,
    authorityBoundaryProbe,
    authorityBoundaryVerification,
    checkpointAuthorityApplier,
    progressDiagnostics: authorityService.progressDiagnostics,
    authorityProbe: authorityService.authorityProbe,
    start,
    stop,
    scan,
    attachedCount: () => attached.size
  };
}

const bridge = globalThis[BRIDGE_KEY] || createBridge();
globalThis[BRIDGE_KEY] = bridge;

setImmediate(() => {
  if (bridge.started) return;
  const core = require('./index');
  bridge.started = bridge.start(core);
});

module.exports = bridge;
