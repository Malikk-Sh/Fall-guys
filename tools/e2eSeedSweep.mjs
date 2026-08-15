// Подбор сида для сквозного браузерного теста.
//
// Гоняет ТОТ ЖЕ простой водитель, что живёт в e2e/full-match.spec.js — держит «вперёд», подруливает
// к оси, жмёт прыжок — по настоящей физике клиента, но без браузера. Один прогон здесь занимает
// доли секунды вместо минут, поэтому можно проверить сотни сочетаний «сид × тайминг».
//
// Запуск: node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
//
// Это инструмент, а не тест: в наборе не участвует. Инвариант выбранного сида живёт в
// server/e2eCourse.test.mjs.

import * as THREE from 'three';
import { createCourseSpec } from '/shared/courseSpec.js';
import { Course } from '../client/game/Course.js';
import { Effects } from '../client/game/Effects.js';
import { Player } from '../client/game/Player.js';

const FIXED_DT = 1 / 60;
const CENTER_TOLERANCE = 0.8;
const DIFFICULTY = 'easy';
const SEGMENTS = Number(process.env.SEGMENTS || 3);
const BUDGET_SECONDS = 150;
const LIMIT_STEPS = Math.round(BUDGET_SECONDS / FIXED_DT);

// Период решения водителя в браузере плавает: обмен со страницей стоит по-разному, а на раннере CI
// программный WebGL роняет FPS. Поэтому годным считается только сид, проходимый на ВСЁМ диапазоне.
const PERIODS_MS = [160, 200, 240, 280, 320, 360, 400, 420];
const PHASES = 8;

function run(seed, periodMs, phaseSteps) {
  const scene = new THREE.Scene();
  const spec = createCourseSpec(seed, DIFFICULTY, SEGMENTS);
  const course = new Course(scene, spec, { quality: 'low' });
  const effects = new Effects(scene, 'low');
  const player = new Player(scene, course, effects);

  const periodSteps = Math.max(1, Math.round(periodMs / 1000 / FIXED_DT));
  let inputX = 0;
  let jump = false;
  let respawns = 0;

  const input = {
    movement: () => ({ x: inputX, forward: 1, magnitude: 1 }),
    consume: action => (action === 'jump' && jump ? ((jump = false), true) : false)
  };

  let steps = 0;
  let finished = false;
  while (steps < LIMIT_STEPS) {
    if ((steps + phaseSteps) % periodSteps === 0) {
      const x = player.position.x;
      inputX = x > CENTER_TOLERANCE ? -1 : x < -CENTER_TOLERANCE ? 1 : 0;
      jump = true;
    }
    const elapsed = steps * FIXED_DT;
    course.update(FIXED_DT, elapsed);
    const before = player.respawns;
    player.step(FIXED_DT, input, 0, elapsed);
    if (player.respawns > before) respawns++;
    steps++;
    if (player.finished) {
      finished = true;
      break;
    }
  }

  const seconds = steps * FIXED_DT;
  player.dispose();
  course.dispose();
  return { finished, seconds, respawns };
}

const seeds = Number(process.env.SEEDS || 400);
const results = [];
for (let seed = 0; seed < seeds; seed++) {
  let ok = true;
  let worst = 0;
  let falls = 0;
  for (const periodMs of PERIODS_MS) {
    for (let phase = 0; phase < PHASES; phase++) {
      const attempt = run(seed, periodMs, phase);
      if (!attempt.finished) {
        ok = false;
        break;
      }
      worst = Math.max(worst, attempt.seconds);
      falls += attempt.respawns;
    }
    if (!ok) break;
  }
  if (!ok) continue;
  const spec = createCourseSpec(seed, DIFFICULTY, SEGMENTS);
  const types = spec.segments.map(segment => segment.type);
  results.push({ seed, worst, falls, types });
}

results.sort((a, b) => a.falls - b.falls || a.worst - b.worst);
console.log(`годных сидов: ${results.length} из ${seeds} (сегментов ${SEGMENTS}, ${DIFFICULTY})`);
for (const item of results.slice(0, 25))
  console.log(
    `сид ${String(item.seed).padStart(3)}  худшее ${item.worst.toFixed(1)}с  падений ${String(item.falls).padStart(3)}  ${item.types.join(' → ')}`
  );
