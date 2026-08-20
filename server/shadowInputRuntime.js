'use strict';

const { ClientInputQueue } = require('./clientInputQueue');
const { ROOM_STATE } = require('../shared/protocol.js');
const { createPlayerSimulationState, stepPlayerMotion } = require('../shared/playerSimulation.js');

const SERVER_SIMULATION_HZ = 30;
const SERVER_SIMULATION_DT = 1 / SERVER_SIMULATION_HZ;
const SERVER_SIMULATION_INTERVAL_MS = 1000 / SERVER_SIMULATION_HZ;
const ERROR_SAMPLE_LIMIT = 512;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function stateFromLegacy(legacy = {}) {
  return createPlayerSimulationState({
    position: {
      x: finite(legacy.x),
      y: finite(legacy.y),
      z: finite(legacy.z)
    },
    velocity: {
      x: finite(legacy.vx),
      y: finite(legacy.vy),
      z: finite(legacy.vz)
    },
    grounded: legacy.state === 'ground',
    finished: legacy.finished === true
  });
}

function copySimulationState(state) {
  if (!state) return null;
  return {
    ...state,
    position: { ...state.position },
    velocity: { ...state.velocity }
  };
}

function neutralInput() {
  return {
    moveX: 0,
    moveZ: 0,
    cameraYaw: 0,
    jumpPressed: false,
    jumpHeld: false,
    divePressed: false
  };
}

function heldInputFromBatch(batch, previous = neutralInput()) {
  if (!batch.length) {
    return {
      ...previous,
      jumpPressed: false,
      divePressed: false
    };
  }

  const latest = batch[batch.length - 1];
  return {
    moveX: latest.moveX,
    moveZ: latest.moveZ,
    cameraYaw: latest.cameraYaw,
    jumpPressed: batch.some(command => command.jumpPressed),
    jumpHeld: latest.jumpHeld,
    divePressed: batch.some(command => command.divePressed)
  };
}

// Collision is still owned by the legacy world layer. Shadow simulation may use that layer's
// current grounded contact, but it never writes anything back into the authoritative player state.
function alignKnownWorldContact(state, legacy = {}) {
  const next = copySimulationState(state);
  if (!next) return null;

  if (legacy.state === 'ground') {
    next.grounded = true;
    next.position.y = finite(legacy.y, next.position.y);
    if (Number.isFinite(legacy.vy)) next.velocity.y = legacy.vy;
    else if (next.velocity.y < 0) next.velocity.y = 0;
  } else if (legacy.state) {
    next.grounded = false;
  }
  return next;
}

class RollingErrorStats {
  constructor(limit = ERROR_SAMPLE_LIMIT) {
    this.limit = limit;
    this.count = 0;
    this.sum = 0;
    this.max = 0;
    this.samples = [];
  }

  record(value) {
    if (!Number.isFinite(value) || value < 0) return false;
    this.count += 1;
    this.sum += value;
    this.max = Math.max(this.max, value);
    this.samples.push(value);
    if (this.samples.length > this.limit) this.samples.shift();
    return true;
  }

  snapshot() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p95Index = sorted.length ? Math.max(0, Math.ceil(sorted.length * 0.95) - 1) : -1;
    return {
      count: this.count,
      mean: this.count ? this.sum / this.count : 0,
      p95: p95Index >= 0 ? sorted[p95Index] : 0,
      max: this.max,
      recentSamples: this.samples.length
    };
  }
}

function rejectionBucket(reason) {
  if (reason === 'stale-sequence') return 'staleSequence';
  if (reason === 'stale-client-tick') return 'staleClientTick';
  if (reason === 'queue-full') return 'queueFull';
  if (reason === 'match-mismatch') return 'matchMismatch';
  return 'invalidOrdering';
}

class ShadowInputRuntime {
  constructor({ step = stepPlayerMotion } = {}) {
    this.step = step;
    this.controllers = new WeakMap();
    this.serverTick = 0;
    this.accepted = 0;
    this.processed = 0;
    this.simulatedSteps = 0;
    this.rejected = {
      staleSequence: 0,
      staleClientTick: 0,
      queueFull: 0,
      matchMismatch: 0,
      invalidOrdering: 0
    };
    this.positionError = new RollingErrorStats();
    this.horizontalError = new RollingErrorStats();
  }

  controllerFor(player, room) {
    let controller = this.controllers.get(player);
    if (!controller || controller.matchId !== room.matchId) {
      controller = {
        matchId: room.matchId,
        queue: new ClientInputQueue(),
        state: stateFromLegacy(player.last),
        input: neutralInput(),
        lastProcessedInput: -1,
        lastServerTick: -1
      };
      this.controllers.set(player, controller);
    }
    return controller;
  }

  accept({ player, room, message }) {
    if (!player || !room || !message || !room.matchId || message.matchId !== room.matchId) {
      this.rejected.matchMismatch += 1;
      return { accepted: false, reason: 'match-mismatch' };
    }

    const controller = this.controllerFor(player, room);
    const result = controller.queue.accept(message);
    if (result.accepted) {
      this.accepted += 1;
      return result;
    }

    this.rejected[rejectionBucket(result.reason)] += 1;
    return result;
  }

  consume(controller, player, { advance }) {
    const batch = controller.queue.drain();
    controller.input = heldInputFromBatch(batch, controller.input);
    if (batch.length) {
      controller.lastProcessedInput = batch[batch.length - 1].sequence;
      this.processed += batch.length;
    }

    if (!advance) {
      // Countdown input may establish held movement, but old jump/dive edges must not fire when the
      // start gate opens seconds later.
      controller.input.jumpPressed = false;
      controller.input.divePressed = false;
      controller.state = stateFromLegacy(player.last);
      return;
    }

    const aligned = alignKnownWorldContact(controller.state, player.last);
    const result = this.step(aligned, controller.input, {}, SERVER_SIMULATION_DT);
    controller.state = result.state;
    controller.lastServerTick = this.serverTick;
    this.simulatedSteps += 1;

    const legacy = player.last;
    if (
      legacy &&
      Number.isFinite(legacy.x) &&
      Number.isFinite(legacy.y) &&
      Number.isFinite(legacy.z)
    ) {
      const dx = controller.state.position.x - legacy.x;
      const dy = controller.state.position.y - legacy.y;
      const dz = controller.state.position.z - legacy.z;
      this.horizontalError.record(Math.hypot(dx, dz));
      this.positionError.record(Math.hypot(dx, dy, dz));
    }

    // Pressed is an edge. Held axes/buttons survive until a newer command arrives; edges do not.
    controller.input.jumpPressed = false;
    controller.input.divePressed = false;
  }

  tick(rooms, now = Date.now()) {
    this.serverTick += 1;
    for (const room of rooms.values()) {
      if (room.state !== ROOM_STATE.COUNTDOWN && room.state !== ROOM_STATE.PLAYING) continue;
      const advance =
        room.state === ROOM_STATE.PLAYING || (room.startedAt && now >= room.startedAt);
      for (const player of room.players.values()) {
        const controller = this.controllers.get(player);
        if (
          !controller ||
          controller.matchId !== room.matchId ||
          player.bot ||
          player.finished
        )
          continue;
        this.consume(controller, player, { advance });
      }
    }
    return this.serverTick;
  }

  snapshot(player) {
    const controller = this.controllers.get(player);
    if (!controller) return null;
    return {
      matchId: controller.matchId,
      pending: controller.queue.size,
      lastProcessedInput: controller.lastProcessedInput,
      lastServerTick: controller.lastServerTick,
      state: copySimulationState(controller.state)
    };
  }

  metrics() {
    return {
      serverHz: SERVER_SIMULATION_HZ,
      serverTick: this.serverTick,
      accepted: this.accepted,
      processed: this.processed,
      simulatedSteps: this.simulatedSteps,
      rejected: { ...this.rejected },
      legacyPositionError: this.positionError.snapshot(),
      legacyHorizontalError: this.horizontalError.snapshot()
    };
  }
}

module.exports = {
  ERROR_SAMPLE_LIMIT,
  SERVER_SIMULATION_DT,
  SERVER_SIMULATION_HZ,
  SERVER_SIMULATION_INTERVAL_MS,
  RollingErrorStats,
  ShadowInputRuntime,
  alignKnownWorldContact,
  heldInputFromBatch,
  stateFromLegacy
};
