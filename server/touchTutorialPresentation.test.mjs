import test from 'node:test';
import assert from 'node:assert/strict';
import { StateRouter } from '../client/core/StateRouter.js';
import { nextTouchTutorialStep, normalizeTouchTutorialSeen } from '../client/ui/TouchTutorialPresentation.js';

test('touch tutorial normalizes only explicit completed flags', () => {
  assert.deepEqual(normalizeTouchTutorialSeen({ move: true, look: 1, jump: false, dive: 'true' }), {
    move: true,
    look: false,
    jump: false,
    dive: false
  });
  assert.deepEqual(normalizeTouchTutorialSeen(null), {
    move: false,
    look: false,
    jump: false,
    dive: false
  });
});

test('touch tutorial always exposes one next step in the documented order', () => {
  assert.equal(nextTouchTutorialStep({}), 'move');
  assert.equal(nextTouchTutorialStep({ move: true }), 'look');
  assert.equal(nextTouchTutorialStep({ move: true, look: true }), 'jump');
  assert.equal(nextTouchTutorialStep({ move: true, look: true, jump: true }), 'dive');
  assert.equal(nextTouchTutorialStep({ move: true, look: true, jump: true, dive: true }), null);
});

test('touch tutorial cannot skip an earlier unseen action', () => {
  assert.equal(nextTouchTutorialStep({ jump: true, dive: true }), 'move');
  assert.equal(nextTouchTutorialStep({ move: true, jump: true, dive: true }), 'look');
});

test('StateRouter subscribers receive real transitions and can unsubscribe', () => {
  const router = new StateRouter({}, { countdown: {}, race: {} });
  const transitions = [];
  const unsubscribe = router.subscribe(event => transitions.push(event));
  assert.equal(router.transition('countdown', { startAt: 10 }), true);
  assert.equal(router.transition('race'), true);
  unsubscribe();
  assert.equal(router.transition('countdown', { startAt: 20 }), true);
  assert.deepEqual(transitions, [
    { name: 'countdown', previous: null, payload: { startAt: 10 } },
    { name: 'race', previous: 'countdown', payload: undefined }
  ]);
});
