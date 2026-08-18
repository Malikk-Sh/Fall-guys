// Подбор сида для сквозного браузерного теста.
//
// Гоняет тот же простой steering policy, что используется e2e/full-match.spec.js, по настоящей
// физике клиента, но без браузера. Один прогон здесь занимает доли секунды вместо минут, поэтому
// можно проверить сотни сочетаний FPS, задержек управления и сидов до запуска дорогого E2E.
//
// Запуск:
//   node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
//   ONLY=130 node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
//   SEEDS=300 node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
//
// Инвариант выбранного сида живёт в server/e2eCourse.test.mjs. Steering policy вынесена отдельно,
// чтобы sweep не повторил ошибку старой версии: браузер уже учитывал vx/lookahead и tolerance 0.16,
// а модель всё ещё выбирала сиды старым алгоритмом с tolerance 0.8.

import * as THREE from 'three';
import { createCourseSpec } from '/shared/courseSpec.js';
import { Course } from '../client/game/Course.js';
import { Effects } from '../client/game/Effects.js';
import { Player } from '../client/game/Player.js';
import { STEER_PULSE_MS, steeringAxis } from '../e2e/helpers/full-match-driver.mjs';

// Ровно значения игрового цикла client/main.js: при низком FPS физика делает не более пяти
// фиксированных подшагов за кадр, а препятствия продолжают жить по настенному времени.
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;
const DIFFICULTY = 'easy';
const SEGMENTS = Number(process.env.SEGMENTS || 3);
const BUDGET_SECONDS = 150;

// 10–15 FPS — диапазон двух Chromium на GitHub runner, 60 FPS — обычная машина.
const FRAME_RATES = [10, 12, 15, 60];
// Реальный round-trip Playwright заметно длиннее nominal waitForTimeout(220). Модель проверяет
// быстрые и медленные циклы вплоть до наблюдённого в CI хвоста ~1.7 с.
const PERIODS_MS = [300, 500, 700, 900, 1200, 1700];
const LATENCIES_MS = [60, 200];
const PHASES = 3;

function run(seed, { fps, periodMs, latencyMs, phase }) {
  const scene = new THREE.Scene();
  const spec = createCourseSpec(seed, DIFFICULTY, SEGMENTS);
  const course = new Course(scene, spec, { quality: 'low' });
  const effects = new Effects(scene, 'low');
  const player = new Player(scene, course, effects);

  const frameDt = 1 / fps;
  let inputX = 0;
  let steerUntil = 0;
  let jump = false;
  let respawns = 0;
  let accumulator = 0;
  let wall = 0;
  let nextPoll = (phase / PHASES) * (periodMs / 1000);
  const inFlight = [];

  const input = {
    movement: () => ({ x: inputX, forward: 1, magnitude: 1 }),
    consume: action => (action === 'jump' && jump ? ((jump = false), true) : false),
    isHeld: () => false
  };

  while (wall < BUDGET_SECONDS && !player.finished) {
    wall += frameDt;

    if (wall >= nextPoll) {
      nextPoll += periodMs / 1000;
      inFlight.push({
        at: wall + latencyMs / 1000,
        axis: steeringAxis({ x: player.position.x, vx: player.velocity.x })
      });
    }

    while (inFlight.length && inFlight[0].at <= wall) {
      const decision = inFlight.shift();
      inputX = decision.axis;
      steerUntil = inputX === 0 ? wall : wall + STEER_PULSE_MS / 1000;
      jump = true;
    }
    if (inputX !== 0 && wall >= steerUntil) inputX = 0;

    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      course.update(FIXED_DT, wall);
      const before = player.respawns;
      player.step(FIXED_DT, input, 0, wall);
      if (player.respawns > before) respawns++;
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) accumulator = 0;
  }

  const finished = player.finished;
  player.dispose();
  course.dispose();
  return { finished, seconds: wall, respawns };
}

function modes() {
  const list = [];
  for (const fps of FRAME_RATES)
    for (const periodMs of PERIODS_MS)
      for (const latencyMs of LATENCIES_MS)
        for (let phase = 0; phase < PHASES; phase++) list.push({ fps, periodMs, latencyMs, phase });
  return list;
}

const only = process.env.ONLY ? Number(process.env.ONLY) : null;

if (only !== null) {
  const spec = createCourseSpec(only, DIFFICULTY, SEGMENTS);
  console.log(`сид ${only}: ${spec.segments.map(s => `${s.type}/v${s.variant}`).join(' → ')}`);
  const byFps = new Map(FRAME_RATES.map(fps => [fps, { passed: 0, total: 0, falls: 0, worst: 0 }]));
  for (const mode of modes()) {
    const attempt = run(only, mode);
    const box = byFps.get(mode.fps);
    box.total++;
    box.falls += attempt.respawns;
    if (attempt.finished) {
      box.passed++;
      box.worst = Math.max(box.worst, attempt.seconds);
    }
  }
  for (const [fps, box] of byFps)
    console.log(
      `  ${String(fps).padStart(2)} кадров: ${box.passed}/${box.total}, худшее ${box.worst.toFixed(1)}с, падений ${box.falls}`
    );
} else {
  const seeds = Number(process.env.SEEDS || 200);
  const all = modes();
  const results = [];
  for (let seed = 0; seed < seeds; seed++) {
    let ok = true;
    let worst = 0;
    let falls = 0;
    for (const mode of all) {
      const attempt = run(seed, mode);
      if (!attempt.finished) {
        ok = false;
        break;
      }
      worst = Math.max(worst, attempt.seconds);
      falls += attempt.respawns;
    }
    if (!ok) continue;
    const spec = createCourseSpec(seed, DIFFICULTY, SEGMENTS);
    results.push({ seed, worst, falls, types: spec.segments.map(segment => segment.type) });
  }

  results.sort((a, b) => a.falls - b.falls || a.worst - b.worst);
  console.log(
    `годных сидов: ${results.length} из ${seeds} (сегментов ${SEGMENTS}, ${DIFFICULTY}, режимов ${all.length})`
  );
  for (const item of results.slice(0, 20))
    console.log(
      `сид ${String(item.seed).padStart(3)}  худшее ${item.worst.toFixed(1)}с  падений ${String(item.falls).padStart(4)}  ${item.types.join(' → ')}`
    );
}
