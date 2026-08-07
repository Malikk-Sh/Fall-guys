// Проверка движения глазами сервера: с одной стороны — настоящий забег настоящей физикой, с другой
// — клиенты, которые движение подделывают.
//
// Оба конца обязательны, и по отдельности каждый бесполезен. Проверка, которая ничего не ловит,
// зелена всегда. Проверка, которая ловит слишком много, тоже зелена — пока не выйдет к живым
// игрокам и не начнёт отменять честные рекорды. Ровно это здесь и случалось: единичный удар
// бампера снимал зачёт с забега, и обнаружилось это не тестами, а сквозным прогоном.
//
// Поэтому сначала — честный бот. Он играет той же физикой, что и человек, а его состояния проходят
// ровно тот путь, что и по сети: validateState, verifyMovement, verifyCheckpointTime. Ни одного
// признака он собрать не должен.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCourseSpec,
  validateState,
  verifyMovement,
  verifyCheckpointTime,
  verifyFinishTime,
  resetHistory,
  spawnFor
} from './gameRules.js';
import { STATE_LIMITS, MAX_SUSTAINED_SPEED, FREE_FALL_MS } from './movementAudit.js';
import { RaceRun, FIXED_DT } from './bots.mjs';

// Клиент шлёт своё состояние раз в 66 мс — см. STATE_INTERVAL_MS в NetworkManager. Тест смотрит на
// забег с той же частотой: разбор движения опирается на интервал между пакетами, и на другой
// частоте он проверял бы не то, что работает в игре.
const SEND_MS = 66;
const START_MS = 1_000_000;

// Прогон честного бота через серверные правила. Возвращает всё, что сервер о нём подумал.
function honestRun(seed, difficulty, { wander = 0, seconds = 120 } = {}) {
  const spec = createCourseSpec(seed, difficulty);
  const run = new RaceRun(spec, { wander });
  const player = {
    checkpoint: 0,
    checkpointAt: START_MS,
    matchStartedAt: START_MS,
    last: null,
    lastAt: null
  };
  const findings = [];
  const rejected = [];
  let nextSend = SEND_MS;

  for (let i = 0; i < Math.round(seconds / FIXED_DT) && !run.finished; i++) {
    const respawned = run.step();
    const now = START_MS + Math.round(run.elapsed * 1000);

    // Возрождение клиент сообщает отдельным сообщением, и сервер сам ставит игрока на чекпоинт.
    // Без этого прыжок на чекпоинт выглядел бы телепортом — но это поведение сервера, а не бота.
    if (respawned) {
      resetHistory(player);
      player.last = { ...spawnFor(spec, player.checkpoint), ry: 0, vx: 0, vz: 0, state: 'air' };
      player.lastAt = now;
      nextSend = run.elapsed * 1000 + SEND_MS;
      continue;
    }
    if (run.elapsed * 1000 < nextSend) continue;
    nextSend += SEND_MS;

    const result = validateState(player, run.snapshot(), spec, now);
    if (!result.ok) {
      rejected.push(result.reason);
      continue;
    }
    findings.push(...verifyMovement(player, result.state, now, spec));
    player.last = { ...result.state };
    player.lastAt = now;
    const segment = verifyCheckpointTime(player, result.checkpoint, now, spec);
    if (segment) findings.push(segment.reason);
    player.checkpoint = result.checkpoint;
  }

  const tail = run.finished ? verifyFinishTime(player, START_MS + Math.round(run.elapsed * 1000)) : null;
  if (tail) findings.push(tail.reason);
  run.dispose();
  return { findings, rejected, checkpoint: player.checkpoint, finished: run.finished, spec };
}

test('честный забег не собирает ни одного признака подделки', () => {
  // Три сложности: у них разная длина, разная скорость препятствий и разный набор сегментов.
  for (const [seed, difficulty] of [
    [7919, 'easy'],
    [15838, 'normal'],
    [23757, 'chaos']
  ]) {
    const result = honestRun(seed, difficulty);
    assert.deepEqual(
      result.findings,
      [],
      `${difficulty}/${seed}: честный забег обязан пройти чисто, а сервер увидел ${result.findings.join(', ')}`
    );
    assert.deepEqual(result.rejected, [], `${difficulty}/${seed}: честные состояния не должны отклоняться`);
    // Проверка не должна быть пустой: бот обязан действительно пройти трассу, а не постоять на старте.
    assert.equal(result.finished, true, `${difficulty}/${seed}: бот обязан дойти до финиша`);
  }
});

// Отдельно — бот, который НЕ держится середины: гуляет от края до края и регулярно падает. Именно
// на нём меряли коридор трассы, и именно он проверяет, что край опоры не считается нарушением.
test('игрок, гуляющий по краям и падающий, тоже проходит чисто', () => {
  const result = honestRun(7919, 'easy', { wander: 1.3, seconds: 90 });
  assert.deepEqual(result.findings, [], `у края трассы сервер увидел ${result.findings.join(', ')}`);
  assert.ok(result.checkpoint > 0, 'бот обязан хотя бы начать трассу');
});

// Дальше — подделки. Каждая проходит тем же путём, что и честный забег.
function cheatRun(spec, states, { gap = SEND_MS, from = null } = {}) {
  const player = {
    checkpoint: 0,
    checkpointAt: START_MS,
    matchStartedAt: START_MS,
    last: from,
    lastAt: from ? START_MS : null
  };
  const findings = new Set();
  const rejected = [];
  let now = START_MS;
  for (const state of states) {
    now += gap;
    const result = validateState(player, state, spec, now);
    if (!result.ok) {
      rejected.push(result.reason);
      continue;
    }
    for (const reason of verifyMovement(player, result.state, now, spec)) findings.add(reason);
    player.last = { ...result.state };
    player.lastAt = now;
    const segment = verifyCheckpointTime(player, result.checkpoint, now, spec);
    if (segment) findings.add(segment.reason);
    player.checkpoint = result.checkpoint;
  }
  return { findings, rejected, player };
}

// Поток состояний: игрок едет вдоль трассы с заданной скоростью, всё остальное задаётся снаружи.
//
// Выход на позицию идёт постепенно. Прыгнуть сразу на высоту двенадцати или на четырнадцать в
// сторону нельзя — это отобьёт жёсткая проверка шага, и до разбора движения дело просто не дойдёт.
// Подделка, которую стоит проверять, начинается там, где шаг допустимый: она не телепортируется,
// а плавно уходит туда, где ей быть нельзя.
const MAX_APPROACH_STEP = 2.5;

function glide(
  spec,
  { speed, from = spec.start.z, x = 0, y = 1.2, state = 'ground', reported = speed, count = 60 }
) {
  const step = (speed * SEND_MS) / 1000;
  const approach = Math.ceil(Math.hypot(x - spec.start.x, y - spec.start.y) / MAX_APPROACH_STEP);
  return Array.from({ length: count + approach }, (_, i) => {
    const share = Math.min(1, (i + 1) / (approach || 1));
    return {
      x: spec.start.x + (x - spec.start.x) * share,
      y: spec.start.y + (y - spec.start.y) * share,
      z: from - step * (i + 1),
      ry: 0,
      vx: 0,
      vy: 0,
      vz: -reported,
      state
    };
  });
}

test('скорость бега втрое выше настоящей не проходит', () => {
  const spec = createCourseSpec(7919, 'easy');
  const { findings } = cheatRun(spec, glide(spec, { speed: 20 }));
  assert.ok(findings.has('reported-speed'), 'заявленные 20 при беговых 7.7 обязаны попасться');
  assert.ok(findings.has('observed-speed'), 'наблюдаемая скорость обязана попасться');
  assert.ok(findings.has('segment-too-fast'), 'сегмент пройден быстрее физического предела');
});

// Главный случай: клиент врёт аккуратно. Он сообщает беговую скорость — заявленной проверке не к
// чему придраться, — но на самом деле едет вдвое быстрее.
//
// Прежние правила такое пропускали: единственный потолок наблюдаемой скорости приходилось держать
// на 22, потому что честный отброс бампером даёт и больше. Разделение по состоянию персонажа
// закрыло эту дыру: на земле отбросов не бывает, и там потолок втрое ниже.
test('аккуратная подделка — честные слова при вдвое большей скорости — попадается', () => {
  const spec = createCourseSpec(7919, 'easy');
  const { findings } = cheatRun(spec, glide(spec, { speed: 16, reported: 7.7 }));
  assert.ok(!findings.has('reported-speed'), 'слова клиента безупречны — придраться должно быть не к чему');
  assert.ok(findings.has('observed-speed'), 'настоящая скорость обязана попасться');
  assert.ok(findings.has('sustained-speed'), 'средняя за окно обязана попасться');
  // Числа подделки выбраны не наугад: они укладываются в воздушные потолки, а прежнее правило
  // ровно ими и обходилось — один потолок на все состояния приходилось держать по самому щедрому.
  assert.ok(
    STATE_LIMITS.air.observed > 16 && STATE_LIMITS.air.reported > 7.7,
    'подделка обязана оставаться в пределах воздушных потолков — иначе она ловится не тем, чем проверяется'
  );
});

test('полёт над трассой попадается', () => {
  const spec = createCourseSpec(7919, 'easy');
  // Летит ровно, на высоте, где ни одно препятствие не достаёт. Скорость беговая — по ней не
  // придраться; невозможен здесь не темп, а то, что игрок не падает.
  const { findings } = cheatRun(spec, glide(spec, { speed: 7, y: 12, state: 'air', count: 80 }));
  assert.ok(findings.has('flight'), 'подъём без опоры выше досягаемости препятствий обязан попасться');
});

test('обход трассы сбоку попадается', () => {
  const spec = createCourseSpec(7919, 'easy');
  // Бежит рядом с трассой, на высоте пола: препятствий там нет, и все они остаются позади.
  const { findings } = cheatRun(spec, glide(spec, { speed: 7, x: 14, y: 1.2, state: 'air', count: 80 }));
  assert.ok(findings.has('flight'), 'за краем опоры игрок обязан падать, а не бежать');
});

test('стояние там, где нет пола, попадается', () => {
  // Ищем трассу с «узким поворотом»: его опора шириной 3.4, и десятка по X — заведомо пустота.
  let spec = null;
  for (let seed = 1; seed < 200 && !spec; seed++) {
    const candidate = createCourseSpec(seed * 131, 'normal');
    if (candidate.segments.some(segment => segment.type === 'bridge')) spec = candidate;
  }
  assert.ok(spec, 'подготовка: нужна трасса с узким поворотом');
  const index = spec.segments.findIndex(segment => segment.type === 'bridge');
  const center = -11 - 18 * index;

  const states = Array.from({ length: 12 }, (_, i) => ({
    x: 8,
    y: 1.2,
    z: center + 4 - i * 0.5,
    ry: 0,
    vx: 0,
    vy: 0,
    vz: -7,
    state: 'ground'
  }));
  const { findings } = cheatRun(spec, states, { from: { x: 8, y: 1.2, z: center + 4.5, vx: 0, vz: -7 } });
  assert.ok(findings.has('off-platform'), 'на узком повороте опоры в восьми единицах от оси нет');
});

test('стояние на высоте, где нет опор, попадается', () => {
  const spec = createCourseSpec(7919, 'easy');
  const states = Array.from({ length: 12 }, (_, i) => ({
    x: 0,
    y: 8,
    z: spec.start.z - i * 0.4,
    ry: 0,
    vx: 0,
    vy: 0,
    vz: -6,
    state: 'ground'
  }));
  const { findings } = cheatRun(spec, states, { from: { x: 0, y: 8, z: spec.start.z, vx: 0, vz: -6 } });
  assert.ok(findings.has('ground-height'), 'все опоры трассы лежат в узкой полосе высот');
});

// Пороги — не круглые числа из головы, и тест это фиксирует: если кто-то поднимет потолок бега до
// воздушного, разделение по состояниям перестанет что-либо значить, и тест обязан об этом сказать.
test('пороги разведены по состояниям, а не совпадают', () => {
  assert.ok(
    STATE_LIMITS.ground.observed < STATE_LIMITS.air.observed / 2,
    'на земле выталкивания препятствием не бывает — потолок обязан быть кратно ниже воздушного'
  );
  assert.ok(
    STATE_LIMITS.dive.reported > STATE_LIMITS.ground.reported,
    'рывок быстрее бега, и потолок обязан это отражать'
  );
  assert.ok(
    MAX_SUSTAINED_SPEED > 10.03,
    'замеренная честная средняя за окно — 10.03, порог обязан быть выше'
  );
  assert.ok(
    FREE_FALL_MS >= 1200,
    'окно свободного падения короче полутора секунд задевало бы подброс пружиной'
  );
});
