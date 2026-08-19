import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isResultsSkipKey,
  resultsRevealPlan,
  validResultsRevealPlan
} from '../client/game/ResultsPresentation.js';

test('results reveal stays ordered and below the UX wait budget', () => {
  const plan = resultsRevealPlan(false);
  assert.equal(validResultsRevealPlan(plan), true);
  assert.ok(plan.complete <= 1500);
  assert.ok(plan.time < plan.stats);
  assert.ok(plan.stats < plan.highlights);
  assert.ok(plan.highlights < plan.actions);
});

test('reduced motion reveals results almost immediately without changing the stage order', () => {
  const normal = resultsRevealPlan(false);
  const reduced = resultsRevealPlan(true);
  assert.equal(validResultsRevealPlan(reduced), true);
  assert.ok(reduced.complete <= 120);
  assert.ok(reduced.complete < normal.time);
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
    validResultsRevealPlan({ time: 10, stats: 5, highlights: 20, actions: 30, complete: 40 }),
    false
  );
  assert.equal(
    validResultsRevealPlan({ time: 0, stats: 10, highlights: 20, actions: 30, complete: Number.NaN }),
    false
  );
});
