import { createPlayerSimulationState, stepPlayerMotion } from '/shared/playerSimulation.js';
import { C2S, S2C } from '/shared/protocol.js';
import { Player } from '../game/Player.js';
import { NetworkManager } from './NetworkManager.js';
import { reconciliationApplicationProposal } from './ReconciliationApplicationPolicy.js';
import {
  applyReconciliationProposal,
  normalizeMovementAuthoritySource
} from './ReconciliationApplicator.js';
import { reconciliationDecision } from './ReconciliationPolicy.js';
import { ReconciliationTelemetry } from './ReconciliationTelemetry.js';

export const CLIENT_INPUT_INTERVAL_MS = 1000 / 30;
export const CLIENT_INPUT_REPLAY_DT = CLIENT_INPUT_INTERVAL_MS / 1000;
export const CLIENT_INPUT_CURSOR_KEY = 'wobble-client-input-shadow-cursor';
export const CLIENT_INPUT_HISTORY_LIMIT = 240;

const PLAYER_PATCH = Symbol.for('wobble.client-input-shadow.player-step');
const NETWORK_TICK_PATCH = Symbol.for('wobble.client-input-shadow.network-tick');
const NETWORK_MESSAGE_PATCH = Symbol.for('wobble.client-input-shadow.network-message');

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
const safeCursor = value =>
  Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER ? value : 0;

export function normalizeRaceAuthoritySource(value) {
  return value === 'legacy' || value === 'shadow' ? value : null;
}

function validShadowState(state) {
  const position = state?.position;
  const velocity = state?.velocity;
  return (
    !!state &&
    typeof state === 'object' &&
    Number.isFinite(position?.x) &&
    Number.isFinite(position?.y) &&
    Number.isFinite(position?.z) &&
    Number.isFinite(velocity?.x) &&
    Number.isFinite(velocity?.y) &&
    Number.isFinite(velocity?.z) &&
    typeof state.grounded === 'boolean'
  );
}

function localSimulationState(player) {
  if (!player?.physics || !player?.velocity) return null;
  if (
    !Number.isFinite(player.physics.x) ||
    !Number.isFinite(player.physics.y) ||
    !Number.isFinite(player.physics.z) ||
    !Number.isFinite(player.velocity.x) ||
    !Number.isFinite(player.velocity.y) ||
    !Number.isFinite(player.velocity.z)
  ) {
    return null;
  }
  return createPlayerSimulationState({
    position: player.physics,
    velocity: player.velocity,
    grounded: player.grounded === true,
    coyoteTime: player.coyote,
    jumpBuffer: player.jumpBuffer,
    diveTimer: player.diveTimer,
    diveCooldown: player.diveCooldown,
    rollTimer: player.rollTimer,
    landingRetention: player.landingRetention,
    recoveryWindow: player.recoveryWindow,
    knockdownTimer: player.knockdownTimer,
    knockdownImmunity: player.knockdownImmunityTimer,
    getupTimer: player.getupTimer,
    slamming: player.slamming,
    gliding: player.gliding,
    finished: player.finished,
    dashes: player.dashes
  });
}

export function simulationStateError(predicted, local) {
  if (!validShadowState(predicted) || !validShadowState(local)) return null;
  const positionDelta = {
    x: predicted.position.x - local.position.x,
    y: predicted.position.y - local.position.y,
    z: predicted.position.z - local.position.z
  };
  const velocityDelta = {
    x: predicted.velocity.x - local.velocity.x,
    y: predicted.velocity.y - local.velocity.y,
    z: predicted.velocity.z - local.velocity.z
  };
  return {
    positionDelta,
    velocityDelta,
    positionError: Math.hypot(positionDelta.x, positionDelta.y, positionDelta.z),
    horizontalPositionError: Math.hypot(positionDelta.x, positionDelta.z),
    verticalPositionError: Math.abs(positionDelta.y),
    velocityError: Math.hypot(velocityDelta.x, velocityDelta.y, velocityDelta.z),
    groundedMismatch: predicted.grounded !== local.grounded
  };
}

function browserStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

export class ClientInputShadowSender {
  constructor({
    storage = browserStorage(),
    now = () => performance.now(),
    historyLimit = CLIENT_INPUT_HISTORY_LIMIT,
    telemetrySampleLimit
  } = {}) {
    this.storage = storage;
    this.now = now;
    this.historyLimit =
      Number.isSafeInteger(historyLimit) && historyLimit > 0 ? historyLimit : CLIENT_INPUT_HISTORY_LIMIT;
    this.activeMatchId = null;
    this.sequence = 0;
    this.clientTick = 0;
    this.lastSentAt = -Infinity;
    this.latest = null;
    this.jumpPressed = false;
    this.divePressed = false;
    this.pendingInputs = [];
    this.lastAcknowledgedInput = -1;
    this.lastAcknowledgedServerTick = -1;
    this.historyDropped = 0;
    this.lastShadowReplay = null;
    this.latestLocalState = null;
    this.latestLocalSampleAt = null;
    this.lastApplicationAttemptServerTick = -1;
    this.lastApplicationResult = null;
    this.telemetry = new ReconciliationTelemetry({ sampleLimit: telemetrySampleLimit });
  }

  readCursor(matchId) {
    if (!this.storage || !matchId) return null;
    try {
      const parsed = JSON.parse(this.storage.getItem(CLIENT_INPUT_CURSOR_KEY) || 'null');
      if (!parsed || parsed.matchId !== matchId) return null;
      return {
        sequence: safeCursor(parsed.sequence),
        clientTick: safeCursor(parsed.clientTick)
      };
    } catch {
      return null;
    }
  }

  persistCursor() {
    if (!this.storage || !this.activeMatchId) return;
    try {
      this.storage.setItem(
        CLIENT_INPUT_CURSOR_KEY,
        JSON.stringify({
          matchId: this.activeMatchId,
          sequence: this.sequence,
          clientTick: this.clientTick
        })
      );
    } catch {
      // Private browsing may deny storage. The in-memory cursor still preserves normal reconnects.
    }
  }

  beginMatch(matchId) {
    const nextMatchId = typeof matchId === 'string' && matchId ? matchId : null;
    if (this.activeMatchId === nextMatchId) return false;
    this.activeMatchId = nextMatchId;
    const cursor = this.readCursor(nextMatchId);
    this.sequence = cursor?.sequence ?? 0;
    this.clientTick = cursor?.clientTick ?? 0;
    this.lastSentAt = -Infinity;
    this.latest = null;
    this.jumpPressed = false;
    this.divePressed = false;
    this.pendingInputs.length = 0;
    this.lastAcknowledgedInput = -1;
    this.lastAcknowledgedServerTick = -1;
    this.historyDropped = 0;
    this.lastShadowReplay = null;
    this.latestLocalState = null;
    this.latestLocalSampleAt = null;
    this.lastApplicationAttemptServerTick = -1;
    this.lastApplicationResult = null;
    this.telemetry.reset(nextMatchId);
    if (nextMatchId && !cursor) this.persistCursor();
    return true;
  }

  capture(input, cameraYaw) {
    if (!input) return false;
    const movement = input.movement?.() || { x: 0, forward: 0 };
    this.latest = {
      moveX: clamp(movement.x, -1, 1),
      moveZ: clamp(movement.forward, -1, 1),
      jumpHeld: input.isHeld?.('jump') === true,
      cameraYaw: clamp(cameraYaw, -100, 100)
    };
    // Player.step consumes these one-shot flags at 60 Hz. Latch them until a 30 Hz network sample
    // is actually emitted so a press between two network ticks cannot disappear.
    this.jumpPressed ||= input.jumpQueued === true;
    this.divePressed ||= input.diveQueued === true;
    return true;
  }

  observeLocalPlayer(player, sampledAt = this.now()) {
    const state = localSimulationState(player);
    if (!state) return false;
    this.latestLocalState = state;
    this.latestLocalSampleAt = Number.isFinite(sampledAt) ? sampledAt : null;
    return true;
  }

  canSend(network) {
    if (!network?.matchId || network.matchId !== this.activeMatchId || !this.latest) return false;
    if (network.finishSentFor === network.matchId) return false;
    if (network.accessBlocked || network.versionMismatch || !network.handshakeReady) return false;
    return network.ws?.readyState === 1 && typeof network.raw === 'function';
  }

  remember(payload) {
    this.pendingInputs.push({ ...payload });
    while (this.pendingInputs.length > this.historyLimit) {
      this.pendingInputs.shift();
      this.historyDropped += 1;
    }
  }

  acknowledge(matchId, sequence, serverTick = null) {
    if (matchId !== this.activeMatchId || !Number.isSafeInteger(sequence) || sequence < 0) return false;
    // `sequence` is the last command the server processed; it can never acknowledge a command the
    // client has not sent yet. Ignoring an impossible future ack keeps the replay window intact if
    // a malformed or stale snapshot ever crosses the migration boundary.
    if (sequence >= this.sequence || sequence <= this.lastAcknowledgedInput) return false;

    this.lastAcknowledgedInput = sequence;
    if (Number.isSafeInteger(serverTick) && serverTick >= 0) {
      this.lastAcknowledgedServerTick = Math.max(this.lastAcknowledgedServerTick, serverTick);
    }
    while (this.pendingInputs.length && this.pendingInputs[0].sequence <= sequence) {
      this.pendingInputs.shift();
    }
    return true;
  }

  replayFromShadow(
    matchId,
    shadowState,
    serverTick,
    lastProcessedInput,
    raceAuthoritySource = null,
    movementAuthoritySource = null
  ) {
    if (matchId !== this.activeMatchId || !validShadowState(shadowState)) return false;
    if (!Number.isSafeInteger(serverTick) || serverTick < 0) return false;
    if (!Number.isSafeInteger(lastProcessedInput) || lastProcessedInput < -1) return false;
    if (lastProcessedInput !== this.lastAcknowledgedInput) return false;
    if (this.lastShadowReplay && serverTick < this.lastShadowReplay.serverTick) return false;

    const baseline = createPlayerSimulationState(shadowState);
    const oldestPending = this.pendingInputs[0]?.sequence ?? null;
    const historyGap = oldestPending !== null && oldestPending > lastProcessedInput + 1;
    let predicted = baseline;
    let replayedInputs = 0;

    if (!historyGap) {
      for (const command of this.pendingInputs) {
        predicted = stepPlayerMotion(predicted, command, {}, CLIENT_INPUT_REPLAY_DT).state;
        replayedInputs += 1;
      }
    }

    const prediction = historyGap ? null : predicted;
    const localError = prediction ? simulationStateError(prediction, this.latestLocalState) : null;
    const correction = reconciliationDecision({ error: localError, historyGap });
    const normalizedAuthoritySource = normalizeRaceAuthoritySource(raceAuthoritySource);
    const normalizedMovementAuthoritySource = normalizeMovementAuthoritySource(movementAuthoritySource);
    const application = reconciliationApplicationProposal({
      raceAuthoritySource: normalizedAuthoritySource,
      correction,
      predicted: prediction
    });
    this.lastShadowReplay = {
      matchId,
      serverTick,
      lastProcessedInput,
      raceAuthoritySource: normalizedAuthoritySource,
      movementAuthoritySource: normalizedMovementAuthoritySource,
      historyGap,
      replayedInputs,
      baseline,
      predicted: prediction,
      localSampleAt: this.latestLocalSampleAt,
      localError,
      correction,
      application,
      applicationResult: null
    };
    this.telemetry.record({ serverTick, historyGap, error: localError, correction });
    return !historyGap;
  }

  applyPendingReconciliation(player) {
    const replay = this.lastShadowReplay;
    if (!replay || replay.serverTick === this.lastApplicationAttemptServerTick) return false;
    this.lastApplicationAttemptServerTick = replay.serverTick;
    this.lastApplicationResult = applyReconciliationProposal(player, replay.application, {
      movementAuthoritySource: replay.movementAuthoritySource
    });
    replay.applicationResult = this.lastApplicationResult;
    return this.lastApplicationResult.applied === true;
  }

  shadowReplayState() {
    if (!this.lastShadowReplay) return null;
    return {
      ...this.lastShadowReplay,
      baseline: createPlayerSimulationState(this.lastShadowReplay.baseline),
      predicted: this.lastShadowReplay.predicted
        ? createPlayerSimulationState(this.lastShadowReplay.predicted)
        : null,
      localError: this.lastShadowReplay.localError ? structuredClone(this.lastShadowReplay.localError) : null,
      correction: this.lastShadowReplay.correction ? { ...this.lastShadowReplay.correction } : null,
      application: this.lastShadowReplay.application
        ? {
            ...this.lastShadowReplay.application,
            state: this.lastShadowReplay.application.state
              ? createPlayerSimulationState(this.lastShadowReplay.application.state)
              : null
          }
        : null,
      applicationResult: this.lastShadowReplay.applicationResult
        ? { ...this.lastShadowReplay.applicationResult }
        : null
    };
  }

  reconciliationDiagnostics() {
    return this.telemetry.snapshot();
  }

  reconciliationState() {
    return {
      matchId: this.activeMatchId,
      lastAcknowledgedInput: this.lastAcknowledgedInput,
      lastAcknowledgedServerTick: this.lastAcknowledgedServerTick,
      pendingCount: this.pendingInputs.length,
      oldestPendingInput: this.pendingInputs[0]?.sequence ?? null,
      latestPendingInput: this.pendingInputs.at(-1)?.sequence ?? null,
      historyDropped: this.historyDropped,
      lastApplicationAttemptServerTick: this.lastApplicationAttemptServerTick,
      lastApplicationResult: this.lastApplicationResult ? { ...this.lastApplicationResult } : null
    };
  }

  flush(network, now = this.now()) {
    if (network?.matchId !== this.activeMatchId) this.beginMatch(network?.matchId);
    if (!this.canSend(network)) return false;
    if (now - this.lastSentAt < CLIENT_INPUT_INTERVAL_MS) return false;

    const payload = {
      type: C2S.CLIENT_INPUT,
      matchId: network.matchId,
      sequence: this.sequence,
      clientTick: this.clientTick,
      moveX: this.latest.moveX,
      moveZ: this.latest.moveZ,
      jumpPressed: this.jumpPressed,
      jumpHeld: this.latest.jumpHeld,
      divePressed: this.divePressed,
      cameraYaw: this.latest.cameraYaw
    };
    network.raw(payload);
    this.remember(payload);
    this.lastSentAt = now;
    this.sequence += 1;
    this.clientTick += 1;
    this.jumpPressed = false;
    this.divePressed = false;
    this.persistCursor();
    return payload;
  }
}

export function installClientInputShadowBridge({
  PlayerClass = Player,
  NetworkClass = NetworkManager,
  sender = defaultClientInputShadowSender
} = {}) {
  if (!PlayerClass.prototype[PLAYER_PATCH]) {
    const originalStep = PlayerClass.prototype.step;
    Object.defineProperty(PlayerClass.prototype, PLAYER_PATCH, { value: originalStep });
    PlayerClass.prototype.step = function clientInputShadowStep(dt, input, cameraYaw, elapsed) {
      const trackLocal = this.finished !== true && this.remote !== true;
      if (trackLocal) {
        sender.applyPendingReconciliation(this);
        sender.capture(input, cameraYaw);
      }
      const result = originalStep.call(this, dt, input, cameraYaw, elapsed);
      if (trackLocal) sender.observeLocalPlayer(this);
      return result;
    };
  }

  if (!NetworkClass.prototype[NETWORK_MESSAGE_PATCH]) {
    const originalHandleMessage = NetworkClass.prototype.handleMessage;
    Object.defineProperty(NetworkClass.prototype, NETWORK_MESSAGE_PATCH, { value: originalHandleMessage });
    NetworkClass.prototype.handleMessage = function clientInputShadowMessage(message) {
      // Reset before normal MATCH_START listeners run, so the first physics sample of a new match
      // cannot inherit movement or one-shot actions from the previous results screen.
      if (message?.type === S2C.MATCH_START) sender.beginMatch(message.matchId);
      if (message?.type === S2C.SNAPSHOT && message.matchId === this.matchId) {
        sender.acknowledge(message.matchId, message.lastProcessedInput, message.serverTick);
        sender.replayFromShadow(
          message.matchId,
          message.shadowPlayerState,
          message.serverTick,
          message.lastProcessedInput,
          message.raceAuthoritySource,
          message.movementAuthoritySource
        );
      }
      const result = originalHandleMessage.call(this, message);
      if (message?.type === S2C.RESUME_FAILED || message?.type === S2C.SERVER_SHUTDOWN) {
        sender.beginMatch(null);
      }
      return result;
    };
  }

  if (!NetworkClass.prototype[NETWORK_TICK_PATCH]) {
    const originalTick = NetworkClass.prototype.tick;
    Object.defineProperty(NetworkClass.prototype, NETWORK_TICK_PATCH, { value: originalTick });
    NetworkClass.prototype.tick = function clientInputShadowTick() {
      const result = originalTick.call(this);
      sender.flush(this);
      return result;
    };
  }

  return sender;
}

export const defaultClientInputShadowSender = new ClientInputShadowSender();
installClientInputShadowBridge();
