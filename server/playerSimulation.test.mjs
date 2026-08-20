import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAYER_SIMULATION_CONSTANTS,
  createPlayerSimulationState,
  normalizePlayerInput,
  stepPlayerMotion
} from '../shared/playerSimulation.js';

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
