import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coopCelebrationMoments,
  coopCelebrationState,
  gestureWeight
} from '../client/game/CoopCelebrationPresentation.js';

const base = {
  revives: 0,
  receivedRevives: 0,
  coreCarrier: null,
  coreInserted: false,
  coreSpeed: 0,
  signalSolved: false
};

test('co-op celebration использует только точные переходы существующего состояния', () => {
  assert.deepEqual(coopCelebrationMoments(base, { ...base, revives: 1 }), ['revive-partner']);
  assert.deepEqual(coopCelebrationMoments(base, { ...base, receivedRevives: 1 }), ['revived-self']);
  assert.deepEqual(coopCelebrationMoments(base, { ...base, coreInserted: true }), ['core-insert']);
  assert.deepEqual(coopCelebrationMoments(base, { ...base, signalSolved: true }), ['signal-solved']);
  assert.deepEqual(coopCelebrationMoments(base, base), []);
});

test('core catch требует server-derived смену carrier после реально движущегося ядра', () => {
  assert.deepEqual(
    coopCelebrationMoments({ ...base, coreSpeed: 4.2 }, { ...base, coreCarrier: 'partner', coreSpeed: 0 }),
    ['core-catch']
  );
  assert.deepEqual(
    coopCelebrationMoments({ ...base, coreSpeed: 0.4 }, { ...base, coreCarrier: 'partner', coreSpeed: 0 }),
    []
  );
  assert.deepEqual(
    coopCelebrationMoments(
      { ...base, coreCarrier: 'self', coreSpeed: 5 },
      { ...base, coreCarrier: 'partner', coreSpeed: 0 }
    ),
    []
  );
});

test('celebration snapshot читает counters и signature state без собственного gameplay truth', () => {
  const state = coopCelebrationState({
    coop: { revives: 2, receivedRevives: 1 },
    coopControl: {
      signatureState: {
        core: {
          carrier: 'partner',
          insertedInto: 'socket',
          velocity: { x: 3, y: 4, z: 0 }
        },
        signal: { solved: true }
      }
    }
  });
  assert.deepEqual(state, {
    revives: 2,
    receivedRevives: 1,
    coreCarrier: 'partner',
    coreInserted: true,
    coreSpeed: 5,
    signalSolved: true
  });
});

test('gesture envelope начинается и заканчивается в нуле и остаётся bounded', () => {
  assert.equal(gestureWeight(1000, 1000), 0);
  assert.equal(gestureWeight(1000, 1620), 0);
  const middle = gestureWeight(1000, 1310);
  assert.ok(middle > 0.99 && middle <= 1);
  assert.equal(gestureWeight(1000, 900), 0);
  assert.equal(gestureWeight(1000, 1100, 0), 0);
});
