import test from 'node:test';
import assert from 'node:assert/strict';
import { RaceSession } from '../client/game/RaceSession.js';

test('RaceSession хранит время и делает финиш идемпотентным', () => {
  const session = new RaceSession().start({ mode: 'single', spec: { seed: 7 }, startedAt: 1_000 });
  assert.equal(session.elapsed(900), 0);
  assert.equal(session.elapsed(2_500), 1_500);
  assert.equal(session.finish(2_500), 1_500);
  assert.equal(session.finish(9_000), 1_500);
  assert.equal(session.elapsed(9_000), 1_500);
  session.confirmFinish(1_480);
  assert.equal(session.finalTime, 1_480);
});

test('RaceSession возобновляет часы после отклонённого финиша', () => {
  const session = new RaceSession().start({ mode: 'multi', spec: {}, startedAt: 5_000 });
  session.finish(7_000);
  session.reopenFinish();
  assert.equal(session.finished, false);
  assert.equal(session.finalTime, 0);
  assert.equal(session.elapsed(8_000), 3_000);
  assert.equal(session.finish(8_100), 3_100);
});

test('RaceSession сохраняет elapsed при смене серверных часов на локальные', () => {
  const session = new RaceSession().start({ mode: 'multi', spec: {}, startedAt: 10_000 });
  assert.equal(session.markUnranked('disconnect'), true);
  assert.equal(session.markUnranked('left'), false);
  assert.equal(session.unranked, 'disconnect');
  assert.equal(session.switchClock(13_250, 50_000), 3_250);
  assert.equal(session.mode, 'single');
  assert.equal(session.elapsed(51_000), 4_250);
  session.shiftStart(2_000);
  assert.equal(session.elapsed(53_000), 4_250);
});

test('RaceSession отклоняет неполное описание старта', () => {
  const session = new RaceSession();
  assert.throws(() => session.start({ mode: 'single', spec: null, startedAt: 0 }), /нужны mode/);
});
