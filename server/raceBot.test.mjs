// Модель мастерства бота-соперника.
//
// Проверяются два свойства, и оба выведены из провалившихся попыток, а не придуманы заранее.
//
// ПЕРВОЕ — бот обязан дойти. Соперник, который не финиширует, не соперник: он просто исчезает из
// протокола, и игрок остаётся в пустой гонке. Первые две редакции модели проваливали именно это:
// низкий темп лишал бота разгона, и слабый уровень доходил в 4 случаях из 8.
//
// ВТОРОЕ — уровни обязаны идти по порядку. Это не самоочевидно: в промежуточной редакции «быстрый»
// оказался медленнее «новичка», потому что слабость задавалась темпом, а темп поднимался до
// полного у каждого разрыва — на трассах с частыми разрывами разница исчезала.
//
// Времена здесь намеренно проверяются как СРЕДНИЕ по нескольким трассам, а не как границы для
// каждого забега. Отдельный забег на «хаосе» может затянуться: препятствия отбрасывают назад, и
// это одинаково верно для бота и для человека.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RaceBot, BOT_SKILLS, BOT_SKILL_IDS, FIXED_DT } from './raceBot.mjs';
import { createCourseSpec } from '/shared/courseSpec.js';
import { Course } from '../client/game/Course.js';

const SEEDS = [4101, 4102, 4103, 4104];
const LIMIT_STEPS = 60 * 200;

function race(skill, seed, difficulty = 'normal') {
  const spec = createCourseSpec(seed, difficulty);
  const course = new Course(new THREE.Scene(), spec, { quality: 'low' });
  const bot = new RaceBot(course, { skill, seed, index: 0 });
  let steps = 0;
  while (!bot.finished && steps < LIMIT_STEPS) {
    bot.step();
    steps += 1;
  }
  const result = { finished: bot.finished, seconds: steps * FIXED_DT };
  bot.dispose();
  course.dispose();
  return result;
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

test('каждый уровень доходит до финиша на каждой трассе', () => {
  for (const skill of BOT_SKILL_IDS) {
    for (const seed of SEEDS) {
      const run = race(skill, seed);
      assert.ok(run.finished, `${skill} не дошёл на сиде ${seed} за ${run.seconds.toFixed(0)} с`);
    }
  }
});

test('уровни идут по порядку: новичок медленнее уверенного, тот медленнее быстрого', () => {
  const times = {};
  for (const skill of BOT_SKILL_IDS) {
    times[skill] = mean(SEEDS.map(seed => race(skill, seed).seconds));
  }
  assert.ok(
    times.rookie > times.steady,
    `новичок (${times.rookie.toFixed(1)}) должен быть медленнее уверенного (${times.steady.toFixed(1)})`
  );
  assert.ok(
    times.steady > times.sharp,
    `уверенный (${times.steady.toFixed(1)}) должен быть медленнее быстрого (${times.sharp.toFixed(1)})`
  );
});

test('сильный уровень не бежит быстрее живого предела трассы', () => {
  // Шесть сегментов по 18 плюс выкат 13 — это 121 единица, а бег ограничен 7.7 в секунду. Быстрее
  // 15 секунд обычную трассу не проходит никто, и бот, показавший меньше, двигался бы не физикой.
  for (const seed of SEEDS) {
    const run = race('sharp', seed);
    assert.ok(run.seconds > 15, `подозрительно быстрый забег: ${run.seconds.toFixed(1)} с`);
  }
});

test('забег бота воспроизводится в точности', () => {
  // Без этого упавший тест невозможно разобрать, а жалобу на бота — проверить.
  const first = race('steady', SEEDS[0]);
  const second = race('steady', SEEDS[0]);
  assert.deepEqual(first, second);
});

test('разные боты одного матча ведут себя по-разному', () => {
  // Один сид трассы, разные номера — иначе все боты в комнате побегут одинаково и будут выглядеть
  // одним игроком, размноженным четырежды.
  const spec = createCourseSpec(SEEDS[1], 'normal');
  const course = new Course(new THREE.Scene(), spec, { quality: 'low' });
  const bots = [0, 1, 2].map(index => new RaceBot(course, { skill: 'steady', seed: SEEDS[1], index }));
  for (let step = 0; step < 60 * 12; step += 1) for (const bot of bots) bot.step();
  const positions = bots.map(bot => bot.position.z.toFixed(2));
  assert.equal(new Set(positions).size, positions.length, `боты идут строем: ${positions.join(', ')}`);
  for (const bot of bots) bot.dispose();
  course.dispose();
});

test('у каждого уровня есть потолок падений, и он растёт к слабому', () => {
  // Свойство таблицы, а не поведения: потолок и есть то, что не даёт слабому боту падать вечно.
  assert.ok(BOT_SKILLS.rookie.falls > BOT_SKILLS.steady.falls);
  assert.ok(BOT_SKILLS.steady.falls > BOT_SKILLS.sharp.falls);
  assert.ok(BOT_SKILLS.sharp.falls >= 1, 'даже сильный бот должен иметь право на одну ошибку');
});

test('имена ботов не выдают в них ботов', () => {
  // Бот помечен отдельным признаком в протоколе. Дублировать пометку в имени не нужно, а имя вида
  // BOT_7734 лишает смысла саму идею соперника.
  const spec = createCourseSpec(SEEDS[0], 'normal');
  const course = new Course(new THREE.Scene(), spec, { quality: 'low' });
  for (let index = 0; index < 12; index += 1) {
    const bot = new RaceBot(course, { seed: SEEDS[0], index });
    assert.match(bot.name, /^[А-ЯЁ][а-яё]+$/, `странное имя: ${bot.name}`);
    bot.dispose();
  }
  course.dispose();
});
