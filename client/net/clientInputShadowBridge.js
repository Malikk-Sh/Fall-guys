import { C2S, S2C } from '/shared/protocol.js';
import { Player } from '../game/Player.js';
import { NetworkManager } from './NetworkManager.js';

export const CLIENT_INPUT_INTERVAL_MS = 1000 / 30;
export const CLIENT_INPUT_CURSOR_KEY = 'wobble-client-input-shadow-cursor';
export const CLIENT_INPUT_HISTORY_LIMIT = 240;

const PLAYER_PATCH = Symbol.for('wobble.client-input-shadow.player-step');
const NETWORK_TICK_PATCH = Symbol.for('wobble.client-input-shadow.network-tick');
const NETWORK_MESSAGE_PATCH = Symbol.for('wobble.client-input-shadow.network-message');

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
const safeCursor = value =>
  Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER ? value : 0;

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
    historyLimit = CLIENT_INPUT_HISTORY_LIMIT
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

  reconciliationState() {
    return {
      matchId: this.activeMatchId,
      lastAcknowledgedInput: this.lastAcknowledgedInput,
      lastAcknowledgedServerTick: this.lastAcknowledgedServerTick,
      pendingCount: this.pendingInputs.length,
      oldestPendingInput: this.pendingInputs[0]?.sequence ?? null,
      latestPendingInput: this.pendingInputs.at(-1)?.sequence ?? null,
      historyDropped: this.historyDropped
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
      if (this.finished !== true && this.remote !== true) sender.capture(input, cameraYaw);
      return originalStep.call(this, dt, input, cameraYaw, elapsed);
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
