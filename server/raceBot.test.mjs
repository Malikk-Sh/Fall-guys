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
// Времена здесь намеренно проверяются по НЕСКОЛЬКИМ трассам сразу, а не как границы для каждого
// забега. Отдельный забег на «хаосе» может затянуться: препятствия отбрасывают назад, и это
// одинаково верно для бота и для человека. Какой именно статистикой — сказано у самой проверки
// порядка: среднее на малой выборке для этого не годится.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RaceBot, BotField, BOT_SKILLS, BOT_SKILL_IDS, FIXED_DT } from './raceBot.mjs';
import { createCourseSpec } from '/shared/courseSpec.js';
import { Course } from '../client/game/Course.js';

const SEEDS = [4101, 4102, 4103, 4104];
const LIMIT_STEPS = 60 * 200;

// Поле забега: трасса, часы и боты на ней. Шагает всегда оно, даже когда бот один, — часы трассы
// принадлежат полю, и бот, двигающий трассу сам, сломал бы её для соседа.
function field(seed, difficulty, make) {
  const spec = createCourseSpec(seed, difficulty);
  const course = new Course(new THREE.Scene(), spec, { quality: 'low' });
  return new BotField(course, make(course));
}

function race(skill, seed, difficulty = 'normal') {
  const run = field(seed, difficulty, course => [new RaceBot(course, { skill, seed, index: 0 })]);
  const [bot] = run.bots;
  let steps = 0;
  while (!bot.finished && steps < LIMIT_STEPS) {
    run.step();
    steps += 1;
  }
  const result = { finished: bot.finished, seconds: steps * FIXED_DT };
  run.dispose();
  return result;
}

test('каждый уровень доходит до финиша на каждой трассе', () => {
  for (const skill of BOT_SKILL_IDS) {
    for (const seed of SEEDS) {
      const run = race(skill, seed);
      assert.ok(run.finished, `${skill} не дошёл на сиде ${seed} за ${run.seconds.toFixed(0)} с`);
    }
  }
});

// Порядок уровней меряется на своей, более широкой выборке трасс и устойчивой статистикой.
//
// Среднее по четырём забегам здесь обманывало. Раз в несколько трасс любой уровень застревает
// надолго — препятствия отбрасывают назад, — и один такой забег на сотню секунд перевешивает
// десяток обычных. На четырёх трассах разница между «уверенным» и «быстрым» выходила порядка 0.6 с
// при времени около 21 с, то есть тест сравнивал шум: правка физики на секунду переворачивала
// результат, ничего не сломав в самой модели.
//
// Замер на сорока трассах: новичок 44.6 с, уверенный 32.0 с, быстрый 28.4 с. Порядок есть, но виден
// он по медиане и по доле трасс, а не по среднему малой выборки. Обе величины ниже проверены и на
// коде до правок сбивания, и после: они не подогнаны под одну версию.
const ORDER_SEEDS = Array.from({ length: 16 }, (_, index) => 4101 + index);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test('уровни идут по порядку: новичок медленнее уверенного, тот медленнее быстрого', () => {
  const times = {};
  for (const skill of BOT_SKILL_IDS) times[skill] = ORDER_SEEDS.map(seed => race(skill, seed).seconds);

  const typical = Object.fromEntries(BOT_SKILL_IDS.map(skill => [skill, median(times[skill])]));
  assert.ok(
    typical.rookie > typical.steady,
    `новичок (${typical.rookie.toFixed(1)}) должен быть медленнее уверенного (${typical.steady.toFixed(1)})`
  );
  assert.ok(
    typical.steady > typical.sharp,
    `уверенный (${typical.steady.toFixed(1)}) должен быть медленнее быстрого (${typical.sharp.toFixed(1)})`
  );

  // Отдельная трасса — лотерея: сильный уровень может застрять там, где слабый прошёл чисто.
  // Порядок означает не «всегда быстрее», а «быстрее на большинстве трасс».
  const ahead = (strong, weak) =>
    times[weak].filter((seconds, index) => seconds > times[strong][index]).length;
  const half = ORDER_SEEDS.length / 2;
  assert.ok(
    ahead('steady', 'rookie') > half,
    `уверенный обгоняет новичка лишь на ${ahead('steady', 'rookie')} трассах из ${ORDER_SEEDS.length}`
  );
  assert.ok(
    ahead('sharp', 'steady') > half,
    `быстрый обгоняет уверенного лишь на ${ahead('sharp', 'steady')} трассах из ${ORDER_SEEDS.length}`
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
  const run = field(SEEDS[1], 'normal', course =>
    [0, 1, 2].map(index => new RaceBot(course, { skill: 'steady', seed: SEEDS[1], index }))
  );
  for (let step = 0; step < 60 * 12; step += 1) run.step();
  const positions = run.bots.map(bot => bot.position.z.toFixed(2));
  assert.equal(new Set(positions).size, positions.length, `боты идут строем: ${positions.join(', ')}`);
  run.dispose();
});

test('соседи по трассе не влияют на забег бота', () => {
  // Трасса на комнату одна, и она ИЗМЕНЯЕМАЯ: движущаяся плита подхватывает стоящего на ней ровно
  // на разницу со своим прошлым положением. Пока каждый бот двигал трассу сам, под своё время,
  // второй отматывал плиту назад к своему моменту — и отмотка прилетала подхватом. Замер на этом
  // же сиде давал расхождение до полутора единиц у второго бота и до восьми на «хаосе»: соперника
  // сдёргивало с плиты на ровном месте.
  //
  // Проверять надо именно НЕ ПЕРВОГО бота: первый шагал по трассе, которую сам же и двигал, и
  // всегда оставался прав. Ошибку получали те, кто шёл за ним.
  const SEED = SEEDS[2];
  const STEPS = 60 * 45;
  const crowd = field(SEED, 'normal', course =>
    [0, 1, 2, 3].map(index => new RaceBot(course, { skill: 'steady', seed: SEED, index }))
  );
  // Трасса без движущихся плит проверяла бы пустое место.
  assert.ok(crowd.course.dynamic.length > 0, 'на трассе нет движущихся плит — проверять нечего');
  for (let step = 0; step < STEPS; step += 1) crowd.step();

  for (const index of [1, 2, 3]) {
    const alone = field(SEED, 'normal', course => [
      new RaceBot(course, { skill: 'steady', seed: SEED, index })
    ]);
    for (let step = 0; step < STEPS; step += 1) alone.step();
    const solo = alone.bots[0].position;
    const together = crowd.bots[index].position;
    assert.equal(together.z.toFixed(4), solo.z.toFixed(4), `соседи увели бота ${index} по дистанции`);
    assert.equal(together.y.toFixed(4), solo.y.toFixed(4), `соседи уронили бота ${index} с плиты`);
    alone.dispose();
  }
  crowd.dispose();
});

test('после реванша бот бежит заново, а не стоит на ленте', () => {
  const run = field(SEEDS[0], 'normal', course => [
    new RaceBot(course, { skill: 'sharp', seed: SEEDS[0], index: 0 })
  ]);
  const [bot] = run.bots;
  let steps = 0;
  while (!bot.finished && steps < LIMIT_STEPS) {
    run.step();
    steps += 1;
  }
  assert.ok(bot.finished, 'первый забег не дошёл');

  run.reset(1);
  assert.equal(bot.finished, false, 'после сброса бот всё ещё на финише');
  assert.ok(bot.position.z > 0, `бот не вернулся на старт: z=${bot.position.z}`);
  let again = 0;
  while (!bot.finished && again < LIMIT_STEPS) {
    run.step();
    again += 1;
  }
  assert.ok(bot.finished, 'второй забег не дошёл');
  run.dispose();
});

test('номер забега сдвигает случайность бота, но не ломает воспроизводимость', () => {
  // Случайность бота детерминирована сидом — без этого упавший тест не разобрать, а жалобу на бота
  // не проверить. Плата за это в том, что реванш на той же трассе рискует стать посекундным
  // повтором первого; номер забега сдвигает поток, оставляя каждый забег воспроизводимым.
  const spec = createCourseSpec(SEEDS[0], 'normal');
  const course = new Course(new THREE.Scene(), spec, { quality: 'low' });
  const bot = new RaceBot(course, { skill: 'rookie', seed: SEEDS[0], index: 0 });
  const draw = () => [0, 1, 2, 3, 4].map(() => bot.random());

  bot.reset(0);
  const first = draw();
  bot.reset(1);
  const second = draw();
  bot.reset(0);
  assert.deepEqual(draw(), first, 'один и тот же забег обязан повторяться в точности');
  assert.notDeepEqual(second, first, 'реванш обязан идти по другому потоку случайности');
  bot.dispose();
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
