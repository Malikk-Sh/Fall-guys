// Подбор сида для сквозного браузерного теста.
//
// Гоняет тот же простой steering policy, что используется e2e/full-match.spec.js, по настоящей
// физике клиента, но без браузера. Главная проверка здесь — ПАРА игроков: именно два Chromium,
// сходящиеся к оси трассы, раньше превращали crowd solver и первый бампер в нестабильность CI.
//
// Запуск:
//   node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
//   ONLY=130 node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
//   SEEDS=300 node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
//   MIN_GOOD_SEEDS=1 SEEDS=300 node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
//
// Инвариант выбранного сида живёт в server/e2eCourse.test.mjs. Steering policy вынесена отдельно,
// чтобы sweep не повторил ошибку старой версии: браузер уже учитывал vx/lookahead и tolerance 0.16,
// а модель всё ещё выбирала сиды старым алгоритмом с tolerance 0.8.

import * as THREE from 'three';
import { createCourseSpec } from '/shared/courseSpec.js';
import { Course } from '../client/game/Course.js';
import { Effects } from '../client/game/Effects.js';
import { Player } from '../client/game/Player.js';
import { resolvePlayerCrowd } from '../client/game/PlayerCollisions.js';
import {
  DRIVER_CONTROL_PERIOD_MS,
  STEER_PULSE_MS,
  steeringAxis
} from '../e2e/helpers/full-match-driver.mjs';

// Ровно значения игрового цикла client/main.js: при низком FPS физика делает не более пяти
// фиксированных подшагов за кадр, а препятствия продолжают жить по настенному времени.
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;
const DIFFICULTY = 'easy';
const SEGMENTS = Number(process.env.SEGMENTS || 3);
const BUDGET_SECONDS = 150;

// Browser full-match запускает второго водителя чуть позже, чтобы два персонажа не входили в
// первый узкий участок одним физическим кадром. Сам второй игрок при этом уже существует в мире и
// участвует в crowd collision — задерживается только его клавиатура.
const RUNNER_STAGGER_SECONDS = 0.9;
const START_LANE_X = 0.875;

// 10–15 FPS — диапазон двух Chromium на GitHub runner, 60 FPS — обычная машина.
const FRAME_RATES = [10, 12, 15, 60];
// Первый режим — точный cadence browser-local driver. Остальные сохраняют запас по задержке,
// чтобы sweep продолжал проверять деградацию runner scheduling, а не только идеальный такт.
const PERIODS_MS = [DRIVER_CONTROL_PERIOD_MS, 300, 500, 700, 900, 1200, 1700];
const LATENCIES_MS = [60, 200];
const PHASES = 3;

function driverFor(player, { periodMs, latencyMs, phase }, startsAt) {
  const state = {
    player,
    startsAt,
    periodMs,
    latencyMs,
    inputX: 0,
    steerUntil: 0,
    jump: false,
    nextPoll: startsAt + (phase / PHASES) * (periodMs / 1000),
    inFlight: []
  };
  state.input = {
    movement: () =>
      state.active ? { x: state.inputX, forward: 1, magnitude: 1 } : { x: 0, forward: 0, magnitude: 0 },
    consume: action => (action === 'jump' && state.jump ? ((state.jump = false), true) : false),
    isHeld: () => false
  };
  return state;
}

function updateDriver(driver, wall) {
  driver.active = wall >= driver.startsAt;
  if (!driver.active) return;

  while (wall >= driver.nextPoll) {
    driver.nextPoll += driver.periodMs / 1000;
    driver.inFlight.push({
      at: wall + driver.latencyMs / 1000,
      axis: steeringAxis({ x: driver.player.position.x, vx: driver.player.velocity.x })
    });
  }

  while (driver.inFlight.length && driver.inFlight[0].at <= wall) {
    const decision = driver.inFlight.shift();
    driver.inputX = decision.axis;
    driver.steerUntil = driver.inputX === 0 ? wall : wall + STEER_PULSE_MS / 1000;
    // В browser driver каждое управляющее решение сопровождается настоящим нажатием Space.
    driver.jump = true;
  }
  if (driver.inputX !== 0 && wall >= driver.steerUntil) driver.inputX = 0;
}

function remoteSnapshot(player) {
  return {
    position: player.position.clone(),
    velocity: player.velocity.clone(),
    finished: player.finished,
    downed: player.downed
  };
}

function runPair(seed, mode) {
  const scene = new THREE.Scene();
  const spec = createCourseSpec(seed, DIFFICULTY, SEGMENTS);
  const course = new Course(scene, spec, { quality: 'low' });
  const effects = new Effects(scene, 'low');
  const host = new Player(scene, course, effects);
  const guest = new Player(scene, course, effects);

  // В реальном race два участника стоят в соседних стартовых линиях. После respawn сама игровая
  // физика снова выбирает checkpoint spawn — это намеренно оставляем Player-у, как в браузере.
  const spawn = course.spawnFor(0);
  host.teleport(new THREE.Vector3(spawn.x - START_LANE_X, spawn.y, spawn.z));
  guest.teleport(new THREE.Vector3(spawn.x + START_LANE_X, spawn.y, spawn.z));

  const hostDriver = driverFor(host, mode, 0);
  const guestDriver = driverFor(guest, { ...mode, phase: (mode.phase + 1) % PHASES }, RUNNER_STAGGER_SECONDS);
  const frameDt = 1 / mode.fps;
  let hostRespawns = 0;
  let guestRespawns = 0;
  let accumulator = 0;
  let wall = 0;

  while (wall < BUDGET_SECONDS && (!host.finished || !guest.finished)) {
    wall += frameDt;
    updateDriver(hostDriver, wall);
    updateDriver(guestDriver, wall);

    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      course.update(FIXED_DT, wall);
      const hostBefore = host.respawns;
      const guestBefore = guest.respawns;

      host.step(FIXED_DT, hostDriver.input, 0, wall);
      guest.step(FIXED_DT, guestDriver.input, 0, wall);

      // Каждый браузер разрешает столкновение только для своего локального игрока и использует
      // remote snapshot. Снимаем обе позиции ДО push, чтобы порядок двух вызовов в этой модели не
      // создавал искусственное преимущество host или guest.
      const hostView = remoteSnapshot(host);
      const guestView = remoteSnapshot(guest);
      resolvePlayerCrowd(host, [['guest', guestView]], FIXED_DT, 'host');
      resolvePlayerCrowd(guest, [['host', hostView]], FIXED_DT, 'guest');

      if (host.respawns > hostBefore) hostRespawns += host.respawns - hostBefore;
      if (guest.respawns > guestBefore) guestRespawns += guest.respawns - guestBefore;
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) accumulator = 0;
  }

  const finished = host.finished && guest.finished;
  const result = {
    finished,
    seconds: wall,
    respawns: hostRespawns + guestRespawns,
    hostFinished: host.finished,
    guestFinished: guest.finished,
    hostRespawns,
    guestRespawns
  };
  host.dispose();
  guest.dispose();
  course.dispose();
  return result;
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
    const attempt = runPair(only, mode);
    const box = byFps.get(mode.fps);
    box.total++;
    box.falls += attempt.respawns;
    if (attempt.finished) {
      box.passed++;
      box.worst = Math.max(box.worst, attempt.seconds);
    }
  }
  let failed = false;
  for (const [fps, box] of byFps) {
    console.log(
      `  ${String(fps).padStart(2)} кадров: пара ${box.passed}/${box.total}, худшее ${box.worst.toFixed(1)}с, падений ${box.falls}`
    );
    if (box.passed !== box.total) failed = true;
  }
  if (failed) {
    console.error(`сид ${only} не проходит все моделируемые timing-режимы`);
    process.exitCode = 1;
  }
} else {
  const seeds = Number(process.env.SEEDS || 200);
  const minGoodSeeds = Number(process.env.MIN_GOOD_SEEDS || 0);
  const all = modes();
  const results = [];
  for (let seed = 0; seed < seeds; seed++) {
    let ok = true;
    let worst = 0;
    let falls = 0;
    for (const mode of all) {
      const attempt = runPair(seed, mode);
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
    `годных сидов: ${results.length} из ${seeds} (пара игроков, сегментов ${SEGMENTS}, ${DIFFICULTY}, режимов ${all.length})`
  );
  for (const item of results.slice(0, 20))
    console.log(
      `сид ${String(item.seed).padStart(3)}  худшее ${item.worst.toFixed(1)}с  падений ${String(item.falls).padStart(4)}  ${item.types.join(' → ')}`
    );

  if (results.length < minGoodSeeds) {
    console.error(`годных сидов ${results.length}, требуется минимум ${minGoodSeeds}`);
    process.exitCode = 1;
  }
}
