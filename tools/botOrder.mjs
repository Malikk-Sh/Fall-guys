// Порядок уровней ботов на широкой выборке трасс.
//
// Запуск: node --experimental-loader ./server/client-loader.mjs tools/botOrder.mjs

import * as THREE from 'three';
import { RaceBot, BotField, BOT_SKILL_IDS, FIXED_DT } from '../server/raceBot.mjs';
import { createCourseSpec } from '/shared/courseSpec.js';
import { Course } from '../client/game/Course.js';

const LIMIT_STEPS = 60 * 200;
const SEEDS = Array.from({ length: Number(process.env.N || 40) }, (_, i) => 4101 + i);

function race(skill, seed, difficulty = 'normal') {
  const spec = createCourseSpec(seed, difficulty);
  const course = new Course(new THREE.Scene(), spec, { quality: 'low' });
  const run = new BotField(course, [new RaceBot(course, { skill, seed, index: 0 })]);
  const [bot] = run.bots;
  let steps = 0;
  while (!bot.finished && steps < LIMIT_STEPS) {
    run.step();
    steps += 1;
  }
  const seconds = steps * FIXED_DT;
  run.dispose();
  return seconds;
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const times = {};
for (const skill of BOT_SKILL_IDS) times[skill] = SEEDS.map(seed => race(skill, seed));

for (const skill of BOT_SKILL_IDS)
  console.log(`${skill.padEnd(7)} среднее ${mean(times[skill]).toFixed(2)} с`);

// Насколько устойчив порядок: на скольких трассах из выборки уровень действительно быстрее соседа.
const wins = (a, b) => times[a].filter((value, index) => value > times[b][index]).length;
console.log(`rookie медленнее steady на ${wins('rookie', 'steady')} из ${SEEDS.length}`);
console.log(`steady медленнее sharp  на ${wins('steady', 'sharp')} из ${SEEDS.length}`);

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log('--- медианы ---');
for (const skill of BOT_SKILL_IDS)
  console.log(`${skill.padEnd(7)} медиана ${median(times[skill]).toFixed(2)} с`);
