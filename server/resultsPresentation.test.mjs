import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isResultsSkipKey,
  primaryResultAction,
  resultsRevealPlan,
  validResultsRevealPlan
} from '../client/game/ResultsPresentation.js';

test('results reveal keeps a bounded finish window before the card enters', () => {
  const plan = resultsRevealPlan(false);
  assert.equal(validResultsRevealPlan(plan), true);
  assert.ok(plan.card >= 600);
  assert.ok(plan.complete <= 1500);
  assert.ok(plan.card < plan.time);
  assert.ok(plan.time < plan.stats);
  assert.ok(plan.stats < plan.highlights);
  assert.ok(plan.highlights < plan.actions);
  assert.equal(plan.actions, plan.complete);
});

test('reduced motion reveals results almost immediately without changing stage order', () => {
  const normal = resultsRevealPlan(false);
  const reduced = resultsRevealPlan(true);
  assert.equal(validResultsRevealPlan(reduced), true);
  assert.equal(reduced.card, 0);
  assert.ok(reduced.complete <= 120);
  assert.ok(reduced.complete < normal.card);
  assert.equal(reduced.actions, reduced.complete);
});

test('one primary result action is chosen from current mode and visible actions', () => {
  const visible = {
    again: true,
    newCourse: true,
    nextChapter: true,
    rematch: true,
    returnLobby: true
  };
  assert.equal(primaryResultAction('single', visible), 'again');
  assert.equal(primaryResultAction('coop', visible), 'nextChapter');
  assert.equal(primaryResultAction('multi', visible), 'rematch');
  assert.equal(primaryResultAction('multi', { returnLobby: true }), 'returnLobby');
  assert.equal(primaryResultAction('single', {}), null);
});

test('results presentation skips only on explicit confirm keys', () => {
  assert.equal(isResultsSkipKey('Enter'), true);
  assert.equal(isResultsSkipKey('NumpadEnter'), true);
  assert.equal(isResultsSkipKey('Space'), true);
  assert.equal(isResultsSkipKey('Escape'), false);
  assert.equal(isResultsSkipKey('KeyW'), false);
});

test('invalid reveal plans fail closed', () => {
  assert.equal(validResultsRevealPlan(null), false);
  assert.equal(
    validResultsRevealPlan({ card: 10, time: 20, stats: 5, highlights: 30, actions: 40, complete: 40 }),
    false
  );
  assert.equal(
    validResultsRevealPlan({
      card: 0,
      time: 10,
      stats: 20,
      highlights: 30,
      actions: 40,
      complete: Number.NaN
    }),
    false
  );
});
