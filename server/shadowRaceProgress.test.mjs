import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { advanceShadowRaceProgress, createShadowRaceProgress } = require('./shadowRaceProgress');

const spec = Object.freeze({
  checkpoints: [-18, -36],
  finishZ: -49
});

const state = (x, y, z) => ({
  position: { x, y, z },
  velocity: { x: 0, y: 0, z: 0 },
  grounded: true
});

test('shadow race progress requires an actual checkpoint-line crossing', () => {
  const start = createShadowRaceProgress(spec);
  assert.deepEqual(start, { checkpoint: 0, finished: false, finishServerTick: null });

  const before = structuredClone(start);
  const result = advanceShadowRaceProgress(start, state(0, 1, -17), state(0, 1, -19), spec, 10);
  assert.equal(result.progress.checkpoint, 1);
  assert.equal(result.progress.finished, false);
  assert.deepEqual(result.events, [{ type: 'checkpoint', checkpoint: 1 }]);
  assert.deepEqual(start, before, 'progress input is never mutated');

  const alreadyBehind = advanceShadowRaceProgress(
    createShadowRaceProgress(spec),
    state(0, 1, -19),
    state(0, 1, -20),
    spec,
    11
  );
  assert.equal(alreadyBehind.progress.checkpoint, 0, 'appearing behind a line is not a crossing');
});

test('one fixed server step can advance at most one checkpoint', () => {
  const result = advanceShadowRaceProgress(
    createShadowRaceProgress(spec),
    state(0, 1, -17),
    state(0, 1, -40),
    spec,
    20
  );
  assert.equal(result.progress.checkpoint, 1);
  assert.deepEqual(result.events, [{ type: 'checkpoint', checkpoint: 1 }]);
});

test('checkpoint crossing preserves the existing server gate for width and height', () => {
  const tooWide = advanceShadowRaceProgress(
    createShadowRaceProgress(spec),
    state(0, 1, -17),
    state(11, 1, -19),
    spec,
    30
  );
  assert.equal(tooWide.progress.checkpoint, 0);

  const tooLow = advanceShadowRaceProgress(
    createShadowRaceProgress(spec),
    state(0, 1, -17),
    state(0, -3, -19),
    spec,
    31
  );
  assert.equal(tooLow.progress.checkpoint, 0);
});

test('server shadow finish is impossible until every checkpoint is owned by server progress', () => {
  const incomplete = advanceShadowRaceProgress(
    createShadowRaceProgress(spec, { checkpoint: 1 }),
    state(0, 1, -48),
    state(0, 1, -49),
    spec,
    40
  );
  assert.equal(incomplete.progress.finished, false);
  assert.equal(incomplete.progress.checkpoint, 1);

  const complete = advanceShadowRaceProgress(
    createShadowRaceProgress(spec, { checkpoint: 2 }),
    state(0, 1, -48),
    state(0, 1, -49),
    spec,
    41
  );
  assert.equal(complete.progress.finished, true);
  assert.equal(complete.progress.finishServerTick, 41);
  assert.deepEqual(complete.events, [{ type: 'finish', checkpoint: 2, serverTick: 41 }]);
});

test('the final checkpoint and finish may be recognized in the same fixed step', () => {
  const result = advanceShadowRaceProgress(
    createShadowRaceProgress(spec, { checkpoint: 1 }),
    state(0, 1, -35),
    state(0, 1, -49),
    spec,
    50
  );
  assert.deepEqual(result.progress, { checkpoint: 2, finished: true, finishServerTick: 50 });
  assert.deepEqual(result.events, [
    { type: 'checkpoint', checkpoint: 2 },
    { type: 'finish', checkpoint: 2, serverTick: 50 }
  ]);
});

test('finished progress is idempotent and invalid states cannot manufacture progress', () => {
  const finished = createShadowRaceProgress(spec, {
    checkpoint: 2,
    finished: true,
    finishServerTick: 60
  });
  const repeated = advanceShadowRaceProgress(finished, state(0, 1, -49), state(0, 1, -60), spec, 61);
  assert.deepEqual(repeated.progress, finished);
  assert.deepEqual(repeated.events, []);

  const invalid = advanceShadowRaceProgress(
    createShadowRaceProgress(spec),
    { position: { x: 0, y: 1, z: Number.NaN } },
    state(0, 1, -19),
    spec,
    62
  );
  assert.equal(invalid.progress.checkpoint, 0);
  assert.equal(invalid.progress.finished, false);
});
