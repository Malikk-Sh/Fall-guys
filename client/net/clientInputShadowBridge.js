import { C2S, S2C } from '/shared/protocol.js';
import { Player } from '../game/Player.js';
import { NetworkManager } from './NetworkManager.js';

export const CLIENT_INPUT_INTERVAL_MS = 1000 / 30;
export const CLIENT_INPUT_CURSOR_KEY = 'wobble-client-input-shadow-cursor';

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
  constructor({ storage = browserStorage(), now = () => performance.now() } = {}) {
    this.storage = storage;
    this.now = now;
    this.activeMatchId = null;
    this.sequence = 0;
    this.clientTick = 0;
    this.lastSentAt = -Infinity;
    this.latest = null;
    this.jumpPressed = false;
    this.divePressed = false;
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
      sender.capture(input, cameraYaw);
      return originalStep.call(this, dt, input, cameraYaw, elapsed);
    };
  }

  if (!NetworkClass.prototype[NETWORK_MESSAGE_PATCH]) {
    const originalHandleMessage = NetworkClass.prototype.handleMessage;
    Object.defineProperty(NetworkClass.prototype, NETWORK_MESSAGE_PATCH, { value: originalHandleMessage });
    NetworkClass.prototype.handleMessage = function clientInputShadowMessage(message) {
      const result = originalHandleMessage.call(this, message);
      if (message?.type === S2C.MATCH_START) sender.beginMatch(this.matchId || message.matchId);
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
