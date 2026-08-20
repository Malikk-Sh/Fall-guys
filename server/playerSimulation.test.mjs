import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYER_SIMULATION_CONSTANTS,
  createPlayerSimulationState,
  normalizePlayerInput,
  stepPlayerMotion
} from '../shared/playerSimulation.js';
import { ALLOWED_IN_STATE, C2S, RATE_LIMITS, ROOM_STATE } from '../shared/protocol.js';
import { validateMessage } from '../shared/validation.js';
import clientInputQueue from './clientInputQueue.js';

const { ClientInputQueue, DEFAULT_MAX_PENDING_INPUTS } = clientInputQueue;
const FIXED_DT = 1 / 60;

function assertFiniteState(state) {
  for (const value of [...Object.values(state.position), ...Object.values(state.velocity)]) {
    assert.equal(Number.isFinite(value), true);
  }
  for (const key of [
    'coyoteTime',
    'jumpBuffer',
    'diveTimer',
    'diveCooldown',
    'rollTimer',
    'landingRetention',
    'recoveryWindow',
    'knockdownTimer',
    'knockdownImmunity',
    'getupTimer'
  ]) {
    assert.equal(Number.isFinite(state[key]), true, `${key} must stay finite`);
    assert.ok(state[key] >= 0, `${key} must stay non-negative`);
  }
}

test('shared player motion is deterministic and does not mutate its inputs', () => {
  const initial = createPlayerSimulationState({
    position: { x: 1, y: 2, z: 3 },
    velocity: { x: 0.5, y: -1, z: 0.25 },
    grounded: false,
    coyoteTime: 0.08
  });
  const input = {
    moveX: 0.35,
    moveZ: 0.9,
    cameraYaw: 1.2,
    jumpPressed: true,
    jumpHeld: true,
    divePressed: false
  };
  const before = structuredClone(initial);

  const a = stepPlayerMotion(initial, input, {}, FIXED_DT);
  const b = stepPlayerMotion(initial, input, {}, FIXED_DT);

  assert.deepEqual(a, b);
  assert.deepEqual(initial, before);
  assertFiniteState(a.state);
});

test('camera-relative input preserves the current forward convention', () => {
  const state = createPlayerSimulationState({ grounded: true });
  const { state: next, intentX } = stepPlayerMotion(
    state,
    { moveX: 0, moveZ: 1, cameraYaw: 0 },
    {},
    FIXED_DT
  );

  assert.equal(intentX, 0);
  assert.ok(next.velocity.z < 0, 'camera-forward at yaw 0 must move toward negative Z');
});

test('jump, coyote time and dive use the existing movement constants', () => {
  const jumpStart = createPlayerSimulationState({ grounded: true });
  const jumped = stepPlayerMotion(jumpStart, { jumpPressed: true }, {}, FIXED_DT);
  assert.ok(jumped.state.velocity.y > 8);
  assert.equal(jumped.state.grounded, false);
  assert.deepEqual(jumped.events, ['jump']);

  const coyoteStart = createPlayerSimulationState({
    grounded: false,
    coyoteTime: PLAYER_SIMULATION_CONSTANTS.COYOTE_TIME
  });
  const coyoteJump = stepPlayerMotion(coyoteStart, { jumpPressed: true }, {}, FIXED_DT);
  assert.deepEqual(coyoteJump.events, ['jump']);

  const dived = stepPlayerMotion(
    createPlayerSimulationState({ grounded: false }),
    { moveZ: 1, divePressed: true },
    {},
    FIXED_DT
  );
  assert.deepEqual(dived.events, ['dive']);
  assert.equal(dived.state.dashes, 1);
  assert.ok(dived.state.diveCooldown > 0.8);
});

test('render cadence cannot change a fixed-step motion result', () => {
  const simulateAt = frameRate => {
    let state = createPlayerSimulationState({ grounded: true });
    let accumulator = 0;
    let steps = 0;
    const frameDt = 1 / frameRate;
    for (let frame = 0; frame < frameRate * 2; frame++) {
      accumulator += frameDt;
      while (accumulator + 1e-12 >= FIXED_DT) {
        state = stepPlayerMotion(state, { moveZ: 1 }, {}, FIXED_DT).state;
        accumulator -= FIXED_DT;
        steps += 1;
      }
    }
    return { state, steps };
  };

  const at30 = simulateAt(30);
  const at60 = simulateAt(60);
  const at144 = simulateAt(144);
  assert.equal(at30.steps, 120);
  assert.equal(at60.steps, 120);
  assert.equal(at144.steps, 120);
  assert.deepEqual(at30.state, at60.state);
  assert.deepEqual(at60.state, at144.state);
});

test('normalization and long input replay keep the state finite', () => {
  assert.equal(normalizePlayerInput({ moveX: 10, moveZ: -10 }).moveMagnitude, 1);

  let state = createPlayerSimulationState({ grounded: false, position: { y: 12 } });
  for (let tick = 0; tick < 1000; tick++) {
    const phase = tick % 120;
    const input = {
      moveX: Math.sin(tick * 0.07),
      moveZ: Math.cos(tick * 0.05),
      cameraYaw: tick * 0.01,
      jumpPressed: phase === 2,
      jumpHeld: phase > 2 && phase < 30,
      divePressed: phase === 45
    };
    state = stepPlayerMotion(state, input, { knockdownControl: 0.25 }, FIXED_DT).state;
    assertFiniteState(state);
  }
});

const validClientInput = () => ({
  type: C2S.CLIENT_INPUT,
  matchId: 'a1b2c3d4e5f60718',
  sequence: 184,
  clientTick: 942,
  moveX: 0.4,
  moveZ: -0.9,
  jumpPressed: false,
  jumpHeld: true,
  divePressed: true,
  cameraYaw: 1.42
});

test('CLIENT_INPUT accepts only bounded player intent, never client coordinates', () => {
  assert.equal(C2S.CLIENT_INPUT, 'input');
  assert.ok(validateMessage(validClientInput()).ok);

  for (const field of [
    'matchId',
    'sequence',
    'clientTick',
    'moveX',
    'moveZ',
    'jumpPressed',
    'jumpHeld',
    'divePressed',
    'cameraYaw'
  ]) {
    const message = validClientInput();
    delete message[field];
    assert.equal(validateMessage(message).ok, false, `${field} должен быть обязательным`);
  }

  for (const [field, value] of [
    ['moveX', 1.001],
    ['moveZ', -1.001],
    ['cameraYaw', Infinity],
    ['jumpPressed', 1],
    ['jumpHeld', 'yes'],
    ['divePressed', null]
  ]) {
    const message = validClientInput();
    message[field] = value;
    assert.equal(validateMessage(message).ok, false, `${field}=${value} должен отклоняться`);
  }

  for (const protectedField of ['x', 'y', 'z', 'vx', 'vz', 'checkpoint', 'position']) {
    const message = { ...validClientInput(), [protectedField]: 0 };
    assert.equal(
      validateMessage(message).ok,
      false,
      `${protectedField} не должен существовать в input-команде`
    );
  }
});

test('CLIENT_INPUT has a 30 Hz-friendly rate budget and race-state boundary', () => {
  assert.deepEqual(RATE_LIMITS[C2S.CLIENT_INPUT], [45, 1000]);
  assert.deepEqual(ALLOWED_IN_STATE[C2S.CLIENT_INPUT], [ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING]);
  assert.equal(ALLOWED_IN_STATE[C2S.CLIENT_INPUT].includes(ROOM_STATE.RESULTS), false);
  assert.equal(ALLOWED_IN_STATE[C2S.CLIENT_INPUT].includes(ROOM_STATE.LOBBY), false);
});

test('server input queue copies commands and drains an atomic batch', () => {
  const queue = new ClientInputQueue();
  const first = validClientInput();
  first.sequence = 0;
  first.clientTick = 10;

  const accepted = queue.accept(first);
  assert.equal(accepted.accepted, true);
  assert.equal(queue.size, 1);
  assert.equal(queue.latest.moveX, 0.4);

  // После accept сетевой объект не владеет содержимым очереди.
  first.moveX = -1;
  assert.equal(queue.latest.moveX, 0.4);

  const batch = queue.drain();
  assert.equal(queue.size, 0);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].sequence, 0);
  batch[0].moveX = 1;
  assert.equal(queue.latest, null);
});

test('server input queue rejects replay, reversed client ticks and invalid ordering fields', () => {
  const queue = new ClientInputQueue();
  const command = (sequence, clientTick) => ({ ...validClientInput(), sequence, clientTick });

  assert.equal(queue.accept(command(5, 100)).accepted, true);
  assert.deepEqual(queue.accept(command(5, 100)), { accepted: false, reason: 'stale-sequence' });
  assert.deepEqual(queue.accept(command(6, 99)), {
    accepted: false,
    reason: 'stale-client-tick'
  });
  assert.equal(queue.accept(command(6, 101)).accepted, true);
  assert.equal(queue.replayed, 1);
  assert.equal(queue.outOfOrderTicks, 1);

  assert.deepEqual(queue.accept(command(6.5, 102)), {
    accepted: false,
    reason: 'invalid-sequence'
  });
  assert.deepEqual(queue.accept(command(7, Number.NaN)), {
    accepted: false,
    reason: 'invalid-client-tick'
  });
});

test('server input queue is memory-bounded without skipping rejected sequence numbers', () => {
  assert.ok(DEFAULT_MAX_PENDING_INPUTS >= 60);
  const queue = new ClientInputQueue({ maxPending: 2 });
  const command = (sequence, clientTick = sequence) => ({
    ...validClientInput(),
    sequence,
    clientTick
  });

  assert.equal(queue.accept(command(0)).accepted, true);
  assert.equal(queue.accept(command(1)).accepted, true);
  assert.deepEqual(queue.accept(command(2)), { accepted: false, reason: 'queue-full' });
  assert.equal(queue.size, 2);
  assert.equal(queue.overflowed, 1);
  assert.equal(queue.lastAcceptedSequence, 1, 'переполнение не подтверждает потерянную команду');

  queue.drain();
  assert.equal(queue.accept(command(2)).accepted, true, 'после drain ту же команду можно принять');
  queue.reset({ nextSequence: 20, nextClientTick: 50 });
  assert.equal(queue.size, 0);
  assert.equal(queue.accept(command(20, 50)).accepted, true);
});
