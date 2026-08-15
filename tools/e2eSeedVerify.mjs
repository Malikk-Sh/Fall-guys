// Проверка выбранного сида на широком диапазоне таймингов и вдвоём.
//
// Запуск: SEED=98 node --experimental-loader ./server/client-loader.mjs tools/e2eSeedVerify.mjs

import * as THREE from 'three';
import { createCourseSpec } from '/shared/courseSpec.js';
import { Course } from '../client/game/Course.js';
import { Effects } from '../client/game/Effects.js';
import { Player } from '../client/game/Player.js';
import { resolvePlayerCrowd } from '../client/game/PlayerCollisions.js';

const FIXED_DT = 1 / 60;
const CENTER_TOLERANCE = 0.8;
const SEED = Number(process.env.SEED || 98);
const SEGMENTS = Number(process.env.SEGMENTS || 3);
const LIMIT_STEPS = Math.round(150 / FIXED_DT);

// Шире, чем при подборе: реальный период решения в браузере зависит от того, сколько стоит один
// обмен со страницей, а на просевшем до 10 FPS раннере он растягивается сильно.
const PERIODS_MS = [100, 140, 180, 220, 260, 300, 340, 380, 420, 460, 500, 560, 620, 700];
const PHASES = 8;

function driver(player) {
  let inputX = 0;
  let jump = false;
  return {
    decide() {
      const x = player.position.x;
      inputX = x > CENTER_TOLERANCE ? -1 : x < -CENTER_TOLERANCE ? 1 : 0;
      jump = true;
    },
    input: {
      movement: () => ({ x: inputX, forward: 1, magnitude: 1 }),
      consume: action => (action === 'jump' && jump ? ((jump = false), true) : false)
    }
  };
}

function run(periodMs, phaseSteps, playerCount) {
  const scene = new THREE.Scene();
  const spec = createCourseSpec(SEED, 'easy', SEGMENTS);
  const course = new Course(scene, spec, { quality: 'low' });
  const effects = new Effects(scene, 'low');
  const players = Array.from({ length: playerCount }, () => new Player(scene, course, effects));
  // Стартовая сетка: в настоящем матче участники стоят не в одной точке.
  players.forEach((player, index) => {
    if (index > 0) player.teleport(new THREE.Vector3(1.4 * index, spec.start.y, spec.start.z + 1.2));
  });
  const drivers = players.map(driver);
  const periodSteps = Math.max(1, Math.round(periodMs / 1000 / FIXED_DT));

  let steps = 0;
  let falls = 0;
  while (steps < LIMIT_STEPS && !players.every(player => player.finished)) {
    if ((steps + phaseSteps) % periodSteps === 0) for (const one of drivers) one.decide();
    const elapsed = steps * FIXED_DT;
    course.update(FIXED_DT, elapsed);
    players.forEach((player, index) => {
      if (player.finished) return;
      const before = player.respawns;
      player.step(FIXED_DT, drivers[index].input, 0, elapsed);
      if (player.respawns > before) falls++;
    });
    // Мягкое расталкивание между участниками — ровно то, что делает клиент в настоящем матче.
    if (playerCount > 1)
      players.forEach((player, index) =>
        resolvePlayerCrowd(
          player,
          players.filter((_, other) => other !== index),
          FIXED_DT
        )
      );
    steps++;
  }
  players.forEach(player => player.dispose());
  course.dispose();
  return { done: players.every(player => player.finished), seconds: steps * FIXED_DT, falls };
}

for (const playerCount of [1, 2]) {
  let passed = 0;
  let total = 0;
  let worst = 0;
  let falls = 0;
  const failures = [];
  for (const periodMs of PERIODS_MS)
    for (let phase = 0; phase < PHASES; phase++) {
      const attempt = run(periodMs, phase, playerCount);
      total++;
      if (attempt.done) {
        passed++;
        worst = Math.max(worst, attempt.seconds);
      } else failures.push(`${periodMs}мс/фаза ${phase}`);
      falls += attempt.falls;
    }
  console.log(
    `сид ${SEED}, ${SEGMENTS} сегмента, игроков ${playerCount}: ${passed}/${total}, худшее ${worst.toFixed(1)}с, падений ${falls}` +
      (failures.length ? `\n  не дошли: ${failures.join(', ')}` : '')
  );
}
