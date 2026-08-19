import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nextTouchTutorialStep,
  normalizeTouchTutorialSeen
} from '../client/ui/TouchTutorialPresentation.js';

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
  assert.equal(
    nextTouchTutorialStep({ move: true, look: true, jump: true, dive: true }),
    null
  );
});

test('touch tutorial cannot skip an earlier unseen action', () => {
  assert.equal(nextTouchTutorialStep({ jump: true, dive: true }), 'move');
  assert.equal(nextTouchTutorialStep({ move: true, jump: true, dive: true }), 'look');
});
