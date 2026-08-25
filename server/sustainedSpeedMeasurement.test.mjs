// Замер устойчивой скорости: две меры одной величины на одном окне.
//
// Признак `sustained-speed` срабатывает на проде у честных игроков чаще, чем позволяет запас, а бот
// не воспроизводит это ни при какой частоте пакетов, ни при петлянии, ни на chaos. Причина
// неизвестна, поэтому здесь ничего не решается — только записывается то, чем причину можно будет
// установить: величина, принимающая решение (среднее по пакетам), и рядом чистое смещение за то же
// окно. Расходятся они ровно тогда, когда путь длиннее прямой между концами окна.
//
// Главное, что держит этот тест: замер ничего не меняет в поведении.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCourseSpec, validateState, verifyMovement, resetHistory, spawnFor } from './gameRules.js';
import { MAX_SUSTAINED_SPEED } from './movementAudit.js';
import { RaceRun, FIXED_DT } from './bots.mjs';

const SEND_MS = 66;
const START_MS = 1_000_000;

const spec = createCourseSpec(9090, 'normal');

// Поток состояний прямо в проверку движения, без бота: тест задаёт траекторию сам.
function feed(states, { dtMs = SEND_MS } = {}) {
  const player = {
    checkpoint: 0,
    checkpointAt: START_MS,
    matchStartedAt: START_MS,
    last: null,
    lastAt: null
  };
  const findings = [];
  let now = START_MS;
  for (const point of states) {
    const state = { ry: 0, vx: 0, vy: 0, vz: 0, state: 'ground', ...point };
    if (player.last) findings.push(...verifyMovement(player, state, now, spec));
    player.last = { ...state };
    player.lastAt = now;
    now += dtMs;
  }
  return { player, findings };
}

// Прямая по Z с заданной скоростью: путь и смещение совпадают. `fromZ` позволяет продолжить
// траекторию с того места, где кончилась предыдущая, — разрыв здесь был бы телепортом, а телепорт
// даёт скорость в сотни единиц и портит окно на две секунды вперёд.
function straight(speed, count, fromZ = 0) {
  const step = (speed * SEND_MS) / 1000;
  return Array.from({ length: count }, (_, i) => ({ x: 0, y: 1, z: fromZ - (i + 1) * step }));
}

// Пила по X при том же продвижении вперёд: путь длиннее прямой, смещение то же.
function weaving(forward, sway, count) {
  const step = (forward * SEND_MS) / 1000;
  return Array.from({ length: count }, (_, i) => ({ x: i % 2 ? sway : -sway, y: 1, z: -i * step }));
}

test('пик записывается по величине, которая принимает решение', () => {
  const { player } = feed(straight(9, 40));
  const peak = player.sustainedSpeedPeak;
  assert.ok(peak, 'окно набралось — пик обязан быть записан');
  assert.ok(Math.abs(peak.average - 9) < 0.5, `среднее ${peak.average} должно быть около 9`);
  // Прямая: смещение и путь совпадают, значит и меры совпадают.
  assert.ok(Math.abs(peak.net - peak.average) < 0.5, 'на прямой две меры обязаны сойтись');
});

// Прямая с неравномерной скоростью: последовательность скоростей по промежуткам.
// Первая точка — исходная: скорости описывают промежутки МЕЖДУ точками, поэтому точек на одну
// больше. Без неё первый промежуток не попадал бы в поток вовсе.
function straightWithSpeeds(speeds) {
  let z = 0;
  const points = [{ x: 0, y: 1, z }];
  for (const speed of speeds) {
    z -= (speed * SEND_MS) / 1000;
    points.push({ x: 0, y: 1, z });
  }
  return points;
}

// Границы у двух мер обязаны совпадать.
//
// При равных промежутках на ПРЯМОЙ среднее по скоростям и смещение за окно равны тождественно:
// (Σ v)/N против (Σ v·dt)/(N·dt). Значит любое расхождение здесь — не свойство траектории, а
// перекос замера. Раньше он был: среднее включало промежуток, приведший в первую точку окна, а
// смещение считалось от самой точки, то есть на один промежуток короче. Один удар в этом
// промежутке подделывал бы ровно тот признак, ради измерения которого замер и сделан.
test('на прямой меры совпадают, даже если первый промежуток окна выбивается', () => {
  const { player } = feed(straightWithSpeeds([30, ...Array(45).fill(8)]));
  const peak = player.sustainedSpeedPeak;
  assert.ok(peak, 'окно набралось');
  assert.ok(peak.average > 8.5, `подготовка: всплеск обязан попасть в окно (среднее ${peak.average})`);
  assert.ok(
    Math.abs(peak.average - peak.net) < 0.1,
    `на прямой меры обязаны совпасть: среднее ${peak.average}, смещение ${peak.net}`
  );
});

test('на петляющей траектории меры расходятся — ради этого замер и делается', () => {
  // Вперёд медленно, вбок широко: путь длинный, смещение короткое.
  const { player } = feed(weaving(3, 2.2, 40));
  const peak = player.sustainedSpeedPeak;
  assert.ok(peak, 'окно набралось');
  assert.ok(
    peak.average > peak.net * 1.5,
    `среднее ${peak.average} должно заметно превышать смещение ${peak.net}`
  );
});

test('замер не меняет решение: признак по-прежнему ставит среднее', () => {
  // Петляние, поднимающее среднее выше порога, но не смещение.
  const sway = 0.9;
  const { player, findings } = feed(weaving(2, sway, 60));
  const peak = player.sustainedSpeedPeak;
  assert.ok(peak.average > MAX_SUSTAINED_SPEED, `подготовка: среднее ${peak.average} выше порога`);
  assert.ok(peak.net < MAX_SUSTAINED_SPEED, `подготовка: смещение ${peak.net} ниже порога`);

  // Признак обязан быть поставлен — по среднему, как и раньше. Замер на это не влияет.
  assert.ok((player.movementAnomalies?.['sustained-speed'] || 0) > 0);
  assert.ok(findings.includes('sustained-speed'), 'запас израсходован — признак становится находкой');
});

test('пик остаётся максимальным за забег, а не последним', () => {
  // Медленный участок продолжается с того места, где кончился быстрый. Разрыв между ними давал бы
  // телепорт, который сам поднимает среднее последнего окна, — и тест проходил бы, даже если пик
  // затирается на каждом окне. Ровно это и было здесь не так.
  const fast = straight(9, 40);
  const slow = straight(2, 40, fast.at(-1).z);
  const { player } = feed([...fast, ...slow]);

  // Последнее окно целиком лежит в медленном участке — проверяем это, а не верим на слово.
  const tail = feed(slow);
  assert.ok(tail.player.sustainedSpeedPeak.average < 3, 'подготовка: медленный хвост даёт около 2');

  assert.ok(
    player.sustainedSpeedPeak.average > 6,
    `пик ${player.sustainedSpeedPeak.average} обязан остаться от быстрого участка`
  );
});

test('без набранного окна пик не выдумывается', () => {
  const { player } = feed(straight(9, 5));
  assert.equal(player.sustainedSpeedPeak, undefined);
});

// Контрольный прогон настоящим ботом через настоящий конвейер. Он же — граница утверждения,
// которое сделано в комментариях: бот признак не воспроизводит, поэтому вслепую формулу не меняем.
test('честный бот признака не даёт, и пик у него далеко от порога', () => {
  const botSpec = createCourseSpec(4242, 'normal');
  const run = new RaceRun(botSpec, {});
  const player = {
    checkpoint: 0,
    checkpointAt: START_MS,
    matchStartedAt: START_MS,
    last: null,
    lastAt: null
  };
  let nextSend = SEND_MS;

  for (let i = 0; i < Math.round(140 / FIXED_DT) && !run.finished; i++) {
    const respawned = run.step();
    const simMs = run.elapsed * 1000;
    const now = START_MS + Math.round(simMs);
    if (respawned) {
      resetHistory(player);
      player.last = { ...spawnFor(botSpec, player.checkpoint), ry: 0, vx: 0, vz: 0, state: 'air' };
      player.lastAt = now;
      nextSend = simMs + SEND_MS;
      continue;
    }
    if (simMs < nextSend) continue;
    nextSend += SEND_MS;
    const result = validateState(player, run.snapshot(), botSpec, now);
    if (!result.ok) continue;
    verifyMovement(player, result.state, now, botSpec);
    player.last = { ...result.state };
    player.lastAt = now;
    player.checkpoint = result.checkpoint;
  }
  run.dispose();

  assert.equal(player.movementAnomalies?.['sustained-speed'] || 0, 0);
  assert.ok(player.sustainedSpeedPeak, 'окно у полного забега обязано набраться');
  assert.ok(
    player.sustainedSpeedPeak.average < MAX_SUSTAINED_SPEED,
    `пик бота ${player.sustainedSpeedPeak.average} обязан оставаться ниже порога ${MAX_SUSTAINED_SPEED}`
  );
});
