// Подбор сида для сквозного браузерного теста.
//
// Гоняет ТОТ ЖЕ простой водитель, что живёт в e2e/full-match.spec.js — держит «вперёд», коротко
// подруливает к оси и жмёт прыжок, — по настоящей физике клиента, но без браузера. Один прогон здесь
// занимает доли секунды вместо минут, поэтому можно проверить сотни сочетаний.
//
// Запуск: node --experimental-loader ./server/client-loader.mjs tools/e2eSeedSweep.mjs
//   SEEDS=200   сколько сидов перебрать
//   ONLY=130    проверить текущий сид и показать разбивку по частоте кадров
//
// Это инструмент, а не тест: в наборе не участвует. Инвариант выбранного сида живёт в
// server/e2eCourse.test.mjs.
//
// ГЛАВНОЕ ПРО МОДЕЛЬ. Первая редакция шагала ровно шестьдесят раз в секунду и считала фазу
// препятствий по игровому времени. Подобранный ею сид обещал ноль падений, а в настоящем браузере
// дал тридцать три. Причина в игровом цикле: физика идёт фиксированными шагами с потолком
// MAX_SUBSTEPS на кадр, а фаза препятствий берётся из courseElapsed() — то есть по НАСТЕННЫМ часам
// забега. При 10–15 кадрах в секунду, а именно столько выдают два Chromium на одной машине, игра
// продвигается медленнее часов, и препятствия уходят вперёд относительно пройденного игроком пути.
// Это другая трасса, а не та же самая помедленнее. Модель ниже воспроизводит цикл как есть.
//
// Вторая ловушка нашлась уже по trace настоящего CI: waitForTimeout(220) не означает, что решение
// приходит каждые 220 мс. На загруженном runner обмены page.evaluate/keyboard растягивали цикл до
// ~0.9 с по медиане и примерно 1.7 с в худшем наблюдённом случае. Старый водитель держал A/D до
// следующего решения, поэтому единичная коррекция превращалась в многосекундный боковой разгон.
// Теперь и браузер, и эта модель используют короткий импульс A/D фиксированной длительности, а
// период опроса перебирается отдельно и включает диапазон, реально увиденный в trace.

import * as THREE from 'three';
import { createCourseSpec } from '/shared/courseSpec.js';
import { Course } from '../client/game/Course.js';
import { Effects } from '../client/game/Effects.js';
import { Player } from '../client/game/Player.js';

// Оба числа — из client/main.js, и расходиться с ними нельзя: на них держится весь смысл модели.
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 5;

const CENTER_TOLERANCE = 0.8;
const STEER_PULSE_MS = 140;
const DIFFICULTY = 'easy';
const SEGMENTS = Number(process.env.SEGMENTS || 3);
const BUDGET_SECONDS = 150;

// Кадры раннера: 10–15 — замер на двух Chromium, 60 — обычная машина. Годный сид обязан проходить
// на всех, иначе тест зелёный только у разработчика.
const FRAME_RATES = [10, 12, 15, 60];
// Фактический период решения гораздо шире номинальной паузы 220 мс: trace красного CI показал
// медиану около 0.9 с и хвост примерно до 1.7 с. Здесь есть и быстрые, и предельно медленные циклы.
const PERIODS_MS = [300, 500, 700, 900, 1200, 1700];
// Задержка доставки решения после чтения позиции моделируется отдельно от частоты самого чтения.
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
  // Решения в пути: посчитаны по позиции на момент опроса, применятся спустя задержку.
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
      const x = player.position.x;
      inFlight.push({
        at: wall + latencyMs / 1000,
        x: x > CENTER_TOLERANCE ? -1 : x < -CENTER_TOLERANCE ? 1 : 0
      });
    }
    while (inFlight.length && inFlight[0].at <= wall) {
      const decision = inFlight.shift();
      inputX = decision.x;
      steerUntil = inputX === 0 ? wall : wall + STEER_PULSE_MS / 1000;
      jump = true;
    }
    // Боковая клавиша сама отпускается через фиксированное окно. Следующий poll может прийти хоть
    // через две секунды — устаревшее решение не остаётся зажатым всё это время.
    if (inputX !== 0 && wall >= steerUntil) inputX = 0;

    // Ровно цикл из client/main.js: фаза препятствий по настенным часам, физика — фиксированным
    // шагом с потолком подшагов на кадр.
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
