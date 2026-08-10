import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { chapterLayout, coopSpec, COOP_CHAPTER_IDS } from '../shared/coopChapters.js';

const require = createRequire(import.meta.url);
const {
  auditCoopMovement,
  verifyCoopCheckpoint,
  minimumCheckpointMs,
  supportAt,
  tetherActive,
  noteAuthoritativeLaunch,
  hasMotionException,
  resetCoopMovement
} = require('./coopMovementAudit.js');

const SEND_MS = 66;
const START_MS = 1_000_000;

function firstLongFloor(chapterId = 'ch1') {
  return chapterLayout(chapterId).pieces.find(piece => piece.kind === 'floor' && piece.length >= 18);
}

function roomFor(chapterId = 'ch1') {
  return { spec: coopSpec(chapterId), players: new Map() };
}

function playerAt(state, at = START_MS) {
  return {
    id: 'p1',
    checkpoint: 0,
    matchStartedAt: at,
    last: { ...state },
    lastAt: at,
    coopMovementAnomalies: {},
    coopMovementHistory: [],
    coopFreeFallSince: null
  };
}

function stateAt({ x = 0, y = 1.2, z = 0, vx = 0, vz = 0, state = 'ground' } = {}) {
  return { x, y, z, ry: 0, vx, vy: 0, vz, state };
}

function feed(room, player, states, start = START_MS) {
  const findings = new Set();
  let now = start;
  for (const state of states) {
    now += SEND_MS;
    for (const reason of auditCoopMovement(room, player, state, now)) findings.add(reason);
    player.last = { ...state };
    player.lastAt = now;
  }
  return { findings, now };
}

function bounceStates(piece, speed, count = 40) {
  const halfSpan = Math.min(4, piece.length / 2 - 2);
  const step = (speed * SEND_MS) / 1000;
  let z = piece.z + halfSpan;
  let direction = -1;
  const states = [];
  for (let index = 0; index < count; index++) {
    let next = z + direction * step;
    if (next < piece.z - halfSpan || next > piece.z + halfSpan) {
      direction *= -1;
      next = z + direction * step;
    }
    z = next;
    states.push(stateAt({ z, vz: direction * speed }));
  }
  return states;
}

function unsupportedZ(spec) {
  for (let z = spec.start.z; z > spec.finishZ; z -= 0.25) {
    if (!supportAt(spec, stateAt({ z }))) return z;
  }
  throw new Error(`Не найден gap в ${spec.chapterId}`);
}

test('обычный кооп-бег не получает признаков подделки', () => {
  const room = roomFor('ch1');
  const piece = firstLongFloor('ch1');
  const initial = stateAt({ z: piece.z + 3, vz: -8 });
  const player = playerAt(initial);
  room.players.set(player.id, player);

  const { findings } = feed(room, player, bounceStates(piece, 8, 50));
  assert.deepEqual([...findings], []);
});

test('систематическое движение быстрее физики попадается без ложного мгновенного порога', () => {
  const room = roomFor('ch1');
  const piece = firstLongFloor('ch1');
  const initial = stateAt({ z: piece.z + 3, vz: -18 });
  const player = playerAt(initial);
  room.players.set(player.id, player);

  const { findings } = feed(room, player, bounceStates(piece, 18, 75));
  assert.equal(findings.has('coop-reported-speed'), false, '18 оставлено ниже шумного мгновенного потолка');
  assert.equal(findings.has('coop-observed-speed'), false, '18 оставлено ниже шумного observed потолка');
  assert.equal(findings.has('coop-sustained-speed'), true, 'средняя скорость обязана поймать систематику');
});

test('стоять и зависать там, где в общей разметке нет опоры, нельзя', () => {
  const room = roomFor('ch1');
  const z = unsupportedZ(room.spec);
  const ground = stateAt({ z });
  const player = playerAt(ground);
  room.players.set(player.id, player);

  const groundRun = feed(room, player, Array.from({ length: 5 }, () => ({ ...ground })));
  assert.equal(groundRun.findings.has('coop-off-platform'), true);

  resetCoopMovement(player, { full: true });
  const air = stateAt({ z, y: 5, state: 'air' });
  player.last = { ...air };
  player.lastAt = START_MS;
  const findings = new Set();
  for (const now of [START_MS + 100, START_MS + 1700, START_MS + 3300, START_MS + 4900]) {
    for (const reason of auditCoopMovement(room, player, air, now)) findings.add(reason);
    player.last = { ...air };
    player.lastAt = now;
  }
  assert.equal(findings.has('coop-flight'), true, 'no-clip hover над gap обязан потерять зачёт');
});

test('серверно подтверждённая катапульта временно разрешает экстремальный полёт и затем истекает', () => {
  const room = roomFor('ch2');
  const piece = firstLongFloor('ch2');
  const state = stateAt({ z: piece.z, y: 7, vz: -45, state: 'air' });
  const player = playerAt(state);
  room.players.set(player.id, player);

  noteAuthoritativeLaunch(player, START_MS);
  assert.equal(hasMotionException(player, START_MS + 2000), true);
  assert.deepEqual(auditCoopMovement(room, player, state, START_MS + 2000), []);
  assert.equal(hasMotionException(player, START_MS + 4000), false, 'исключение не живёт всю главу');

  const findings = new Set();
  for (let index = 0; index < 6; index++) {
    const now = START_MS + 4100 + index * SEND_MS;
    for (const reason of auditCoopMovement(room, player, state, now)) findings.add(reason);
    player.last = { ...state };
    player.lastAt = now;
  }
  assert.equal(findings.has('coop-reported-speed'), true, 'после окна та же скорость снова проверяется');
});

test('натянутый tether ослабляет observed-проверку, но не разрешает врать о собственной скорости', () => {
  const room = roomFor('ch10');
  const piece = firstLongFloor('ch10');
  const partner = { id: 'p2', last: stateAt({ x: 5, z: piece.z }), disconnectedAt: null };
  const player = playerAt(stateAt({ x: -8, z: piece.z, vz: -8 }));
  room.players.set(player.id, player);
  room.players.set(partner.id, partner);

  const pulled = stateAt({ x: -5, z: piece.z, vz: -8, state: 'air' });
  assert.equal(tetherActive(room, player, pulled), true);
  assert.deepEqual(auditCoopMovement(room, player, pulled, START_MS + SEND_MS), []);

  player.last = { ...pulled };
  player.lastAt = START_MS + SEND_MS;
  const impossible = { ...pulled, vz: -60 };
  const findings = new Set();
  for (let index = 0; index < 6; index++) {
    const now = START_MS + (index + 2) * SEND_MS;
    for (const reason of auditCoopMovement(room, player, impossible, now)) findings.add(reason);
    player.last = { ...impossible };
    player.lastAt = now;
  }
  assert.equal(findings.has('coop-reported-speed'), true);
});

test('moving platform учитывается как допустимая поперечная опора', () => {
  const spec = coopSpec('ch2');
  const moving = chapterLayout('ch2').pieces.find(piece => piece.kind === 'movingSpan');
  assert.ok(moving, 'в ch2 должна быть moving platform');
  const support = supportAt(spec, stateAt({ x: Math.abs(moving.range || 0) + 2.5, z: moving.z }));
  assert.equal(support?.piece.kind, 'movingSpan');
});

test('checkpoint обязан пересекаться в игровой области и не быстрее физического минимума', () => {
  const spec = coopSpec('ch1');
  assert.ok(minimumCheckpointMs(spec, 1) >= 450);

  const outside = playerAt(stateAt({ z: spec.start.z }));
  assert.equal(
    verifyCoopCheckpoint(outside, spec, 1, stateAt({ x: 10, z: spec.checkpoints[0] - 0.2 }), START_MS + 5000)
      ?.reason,
    'coop-checkpoint-region'
  );

  const tooFast = playerAt(stateAt({ z: spec.start.z }));
  assert.equal(
    verifyCoopCheckpoint(tooFast, spec, 1, stateAt({ z: spec.checkpoints[0] - 0.2 }), START_MS + 100)?.reason,
    'coop-segment-too-fast'
  );

  const normal = playerAt(stateAt({ z: spec.start.z }));
  assert.equal(
    verifyCoopCheckpoint(normal, spec, 1, stateAt({ z: spec.checkpoints[0] - 0.2 }), START_MS + 10_000),
    null
  );
});

test('у каждой главы каждый checkpoint получает конечный физический минимум', () => {
  for (const chapterId of COOP_CHAPTER_IDS) {
    const spec = coopSpec(chapterId);
    for (let checkpoint = 1; checkpoint <= spec.segmentCount; checkpoint++) {
      const minimum = minimumCheckpointMs(spec, checkpoint);
      assert.equal(Number.isFinite(minimum), true, `${chapterId}/cp${checkpoint}`);
      assert.ok(minimum >= 450, `${chapterId}/cp${checkpoint}: minimum=${minimum}`);
      assert.ok(minimum < 15_000, `${chapterId}/cp${checkpoint}: minimum=${minimum}`);
    }
  }
});
