// Проверка выбранного сида на широком диапазоне таймингов и вдвоём.
//
// Запуск: SEED=130 node --experimental-loader ./server/client-loader.mjs tools/e2eSeedVerify.mjs

import * as THREE from 'three';
import { createCourseSpec } from '/shared/courseSpec.js';
import { raceSpawnFor } from '/shared/raceGrid.js';
import { Course } from '../client/game/Course.js';
import { Effects } from '../client/game/Effects.js';
import { Player } from '../client/game/Player.js';
import { resolvePlayerCrowd } from '../client/game/PlayerCollisions.js';

const FIXED_DT = 1 / 60;
const CENTER_TOLERANCE = 0.8;
const STEER_PULSE_MS = 140;
const STEER_PULSE_SECONDS = STEER_PULSE_MS / 1000;
const SEED = Number(process.env.SEED || 130);
const SEGMENTS = Number(process.env.SEGMENTS || 3);
const LIMIT_STEPS = Math.round(150 / FIXED_DT);

// Trace настоящего красного CI показал, что цикл evaluate → keyboard → wait далеко не равен
// номинальным 220 мс: медиана была около 0.9 с, отдельные циклы доходили примерно до 1.7 с.
// Проверяем обе стороны этого диапазона. Сам боковой ввод при этом ограничен отдельным импульсом,
// как и в браузерном водителе: редкий poll не превращается в многосекундно зажатую A/D.
const PERIODS_MS = [300, 500, 700, 900, 1200, 1500, 1800];
const PHASES = 8;
const STEER_STEPS = Math.max(1, Math.round(STEER_PULSE_SECONDS / FIXED_DT));

function driver(player) {
  let inputX = 0;
  let steerSteps = 0;
  let jump = false;
  return {
    decide() {
      const x = player.position.x;
      inputX = x > CENTER_TOLERANCE ? -1 : x < -CENTER_TOLERANCE ? 1 : 0;
      steerSteps = inputX === 0 ? 0 : STEER_STEPS;
      jump = true;
    },
    afterStep() {
      if (steerSteps <= 0) return;
      steerSteps--;
      if (steerSteps === 0) inputX = 0;
    },
    input: {
      movement: () => ({ x: inputX, forward: 1, magnitude: 1 }),
      consume: action => (action === 'jump' && jump ? ((jump = false), true) : false),
      isHeld: () => false
    }
  };
}

function run(periodMs, phaseSteps, playerCount) {
  const scene = new THREE.Scene();
  const spec = createCourseSpec(SEED, 'easy', SEGMENTS);
  const course = new Course(scene, spec, { quality: 'low' });
  const effects = new Effects(scene, 'low');
  const players = Array.from({ length: playerCount }, () => new Player(scene, course, effects));

  // Точная общая стартовая решётка из production-кода, а не приближение. Для двух участников это
  // x = ±0.875 на одной линии Z; именно эти значения видны в CI trace до конца отсчёта.
  players.forEach((player, index) => {
    const spawn = raceSpawnFor(spec, index, playerCount);
    player.teleport(new THREE.Vector3(spawn.x, spawn.y, spawn.z));
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
      drivers[index].afterStep();
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
