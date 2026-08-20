'use strict';

// Bounded staging queue for the future authoritative server tick.
//
// WebSocket delivery and simulation time are deliberately separate concerns: socket handlers append
// validated intent commands here, while a fixed server tick will consume them later. The queue owns
// ordering and memory bounds only; it never advances physics and never trusts client coordinates.

const DEFAULT_MAX_PENDING_INPUTS = 120;

function safePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function copyCommand(message) {
  return {
    sequence: message.sequence,
    clientTick: message.clientTick,
    moveX: message.moveX,
    moveZ: message.moveZ,
    jumpPressed: message.jumpPressed,
    jumpHeld: message.jumpHeld,
    divePressed: message.divePressed,
    cameraYaw: message.cameraYaw
  };
}

class ClientInputQueue {
  constructor({ maxPending = DEFAULT_MAX_PENDING_INPUTS } = {}) {
    this.maxPending = safePositiveInteger(maxPending, DEFAULT_MAX_PENDING_INPUTS);
    this.pending = [];
    this.lastAcceptedSequence = -1;
    this.lastClientTick = -1;
    this.replayed = 0;
    this.outOfOrderTicks = 0;
    this.overflowed = 0;
  }

  get size() {
    return this.pending.length;
  }

  get latest() {
    const command = this.pending[this.pending.length - 1];
    return command ? { ...command } : null;
  }

  // The protocol validator runs before this boundary, but ordering fields are checked again here.
  // They are control data for memory/simulation scheduling, so accepting fractions/NaN/stale values
  // would make the queue itself unreliable even if a future caller bypassed the socket validator.
  accept(message) {
    if (!message || !Number.isSafeInteger(message.sequence) || message.sequence < 0) {
      return { accepted: false, reason: 'invalid-sequence' };
    }
    if (!Number.isSafeInteger(message.clientTick) || message.clientTick < 0) {
      return { accepted: false, reason: 'invalid-client-tick' };
    }
    if (message.sequence <= this.lastAcceptedSequence) {
      this.replayed += 1;
      return { accepted: false, reason: 'stale-sequence' };
    }
    if (message.clientTick < this.lastClientTick) {
      this.outOfOrderTicks += 1;
      return { accepted: false, reason: 'stale-client-tick' };
    }
    if (this.pending.length >= this.maxPending) {
      this.overflowed += 1;
      return { accepted: false, reason: 'queue-full' };
    }

    const command = copyCommand(message);
    this.pending.push(command);
    this.lastAcceptedSequence = command.sequence;
    this.lastClientTick = command.clientTick;
    return { accepted: true, command: { ...command } };
  }

  // A server tick consumes an atomic snapshot. Commands arriving after this call remain for the next
  // tick instead of mutating the array being iterated by simulation code.
  drain() {
    if (!this.pending.length) return [];
    const drained = this.pending;
    this.pending = [];
    return drained.map(command => ({ ...command }));
  }

  reset({ nextSequence = 0, nextClientTick = 0 } = {}) {
    this.pending = [];
    this.lastAcceptedSequence = Number.isSafeInteger(nextSequence) ? nextSequence - 1 : -1;
    this.lastClientTick = Number.isSafeInteger(nextClientTick) ? nextClientTick - 1 : -1;
  }
}

module.exports = {
  DEFAULT_MAX_PENDING_INPUTS,
  ClientInputQueue
};
