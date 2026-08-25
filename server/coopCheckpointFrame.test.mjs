// Одна рамка арки на выдачу чекпоинта и на проверку результата — в кооперативе.
//
// Раньше их было две. Выдачу делал общий `validateState` по гоночной рамке (полуширина 11, без
// верхней границы по Y), проверку — `verifyCoopCheckpoint` по своей (7.5 и Y от -2 до 10).
// Промежуток между ними был ловушкой, и притом худшего вида: пересечение сбоку от дорожки чекпоинт
// ВЫДАВАЛО и тем же движением снимало проверку со ВСЕЙ главы — рекорд, прогресс, награды. Пара
// проходила арку и молча теряла зачёт за то, что сервер ей сам и засчитал.
//
// Промежуток лежал целиком за краем дорожки: арки во всех десяти главах стоят над полом шириной 12,
// то есть честное пересечение — это |x| ≤ 6. Сузить выдачу до проверочной рамки честным парам не
// стоит ничего, а ловушку убирает. Клиент при этом остаётся мягче сервера и, отстав, догоняет —
// см. `server/checkpointFrameDirection.test.mjs`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateState } from './gameRules.js';
import { verifyCoopCheckpoint } from './coopMovementAudit.js';
import { coopSpec, COOP_CHECKPOINT_FRAME } from '../shared/coopChapters.js';
import { createCourseSpec } from '../shared/courseSpec.js';
import { crossedCheckpoint, RACE_CHECKPOINT_FRAME } from '../shared/courseProgress.js';

const spec = coopSpec('ch1');
const LINE = spec.checkpoints[0];
const NOW = 1_000_000;

// Пересечение плоскости арки в точке (x, y): предыдущее состояние перед чертой, новое — за ней.
function crossAt(x, y) {
  const player = {
    slot: 0,
    checkpoint: 0,
    checkpointAt: NOW,
    matchStartedAt: NOW,
    coopLastCheckpointAt: NOW - 60_000,
    last: { x, y, z: LINE + 0.5, ry: 0, vx: 0, vy: 0, vz: -8, state: 'ground' },
    lastAt: NOW - 100
  };
  const state = { x, y, z: LINE - 0.5, ry: 0, vx: 0, vy: 0, vz: -8, state: 'ground' };
  const result = validateState(player, state, spec, NOW);
  return { player, state, result };
}

test('пересечение сбоку от дорожки чекпоинт больше не выдаёт', () => {
  const beside = COOP_CHECKPOINT_FRAME.halfWidth + 1.5; // 9: внутри гоночной рамки, вне дорожки
  const { result } = crossAt(beside, 1.2);
  assert.equal(result.ok, true, 'состояние само по себе допустимое — отказывать в нём не за что');
  assert.equal(result.checkpoint, 0, `арка сбоку (x ${beside}) засчитываться не должна`);

  // И это ровно тот промежуток, который раньше выдавал: по гоночной рамке та же точка проходит.
  const from = { x: beside, y: 1.2, z: LINE + 0.5 };
  const to = { x: beside, y: 1.2, z: LINE - 0.5 };
  assert.equal(crossedCheckpoint(from, to, LINE, RACE_CHECKPOINT_FRAME), true);
  assert.equal(crossedCheckpoint(from, to, LINE, COOP_CHECKPOINT_FRAME), false);
});

test('пересечение под трассой и над ней тоже не выдаёт', () => {
  // Гоночная рамка пускает всё, что выше -3, и не имеет верхней границы вовсе.
  for (const y of [COOP_CHECKPOINT_FRAME.minY - 0.5, COOP_CHECKPOINT_FRAME.maxY + 2]) {
    const { result } = crossAt(0, y);
    assert.equal(result.checkpoint, 0, `арка на высоте ${y} засчитываться не должна`);
  }
});

test('честное пересечение по дорожке выдаёт арку как раньше', () => {
  for (const x of [0, -5.5, 5.5]) {
    const { result } = crossAt(x, 1.2);
    assert.equal(result.checkpoint, 1, `честное пересечение (x ${x}) обязано засчитываться`);
  }
});

// Главное следствие: выдача и проверка отвечают про одну точку одинаково, поэтому пара, получившая
// чекпоинт, не может тем же движением потерять проверку главы.
test('выданный чекпоинт проверку главы не снимает — ни при каком месте пересечения', () => {
  const sweep = [];
  for (let x = -13; x <= 13; x += 0.25) sweep.push(Math.round(x * 100) / 100);

  let granted = 0;
  for (const y of [-2.5, -1.9, 0, 1.2, 4, 9.9, 10.5]) {
    for (const x of sweep) {
      const { player, result } = crossAt(x, y);
      if (result.checkpoint === 0) continue;
      granted++;
      const finding = verifyCoopCheckpoint(player, spec, result.checkpoint, result.state, NOW, player.last);
      assert.equal(
        finding,
        null,
        `чекпоинт выдан в (${x}, ${y}), а проверка его же и отменила: ${finding?.reason}`
      );
    }
  }
  assert.ok(granted > 100, `выборка обязана попадать внутрь рамки, а попала ${granted} раз`);
});

test('старая пара рамок этот же прогон заваливала', () => {
  // Воспроизводим прежнее поведение: выдача по гоночной рамке, проверка — по кооперативной.
  const beside = COOP_CHECKPOINT_FRAME.halfWidth + 1.5;
  const from = { x: beside, y: 1.2, z: LINE + 0.5 };
  const to = { x: beside, y: 1.2, z: LINE - 0.5, ry: 0, vx: 0, vy: 0, vz: -8, state: 'ground' };
  assert.equal(crossedCheckpoint(from, to, LINE, RACE_CHECKPOINT_FRAME), true, 'выдача: засчитала');

  const player = {
    slot: 0,
    checkpoint: 0,
    coopLastCheckpointAt: NOW - 60_000,
    matchStartedAt: NOW - 60_000,
    last: from
  };
  const finding = verifyCoopCheckpoint(player, spec, 1, to, NOW, from);
  assert.equal(finding?.reason, 'coop-checkpoint-region', 'проверка: сняла зачёт с главы');
});

test('гоночная выдача не тронута', () => {
  const race = createCourseSpec(4242, 'normal');
  const line = race.checkpoints[0];
  const beside = COOP_CHECKPOINT_FRAME.halfWidth + 1.5;
  const player = {
    checkpoint: 0,
    checkpointAt: NOW,
    matchStartedAt: NOW,
    last: { x: beside, y: 1.2, z: line + 0.5, ry: 0, vx: 0, vy: 0, vz: -8, state: 'ground' },
    lastAt: NOW - 100
  };
  const state = { x: beside, y: 1.2, z: line - 0.5, ry: 0, vx: 0, vy: 0, vz: -8, state: 'ground' };
  const result = validateState(player, state, race, NOW);
  assert.equal(result.checkpoint, 1, 'гонка обязана засчитывать там же, где засчитывала');

  // И гоночная рамка по-прежнему без верхней границы: над трассой только небо.
  assert.equal(RACE_CHECKPOINT_FRAME.maxY, Infinity);
});
