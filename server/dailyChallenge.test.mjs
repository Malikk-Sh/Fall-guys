import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_MODIFIERS,
  DAILY_OBJECTIVES,
  coursePar,
  dailyCourseSpec,
  dailySeed,
  evaluateCourseObjectives,
  modifierForDay,
  objectiveForDay
} from '../client/core/Config.js';
import { checkObjective, dayNumber } from '../client/core/dailyModifiers.js';
import { playerTuning } from '../client/game/Player.js';
import {
  dailyObjectiveState,
  dailyPresentationModel,
  dailyResetRemaining,
  formatDailyCountdown,
  nextDailyReward
} from '../client/ui/DailyChallengePresentation.js';

const at = value => new Date(`${value}T12:00:00Z`);
const days = (from, count) =>
  Array.from({ length: count }, (_, i) => {
    const date = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000);
    return date.toISOString().slice(0, 10);
  });

test('испытание дня одинаково для всех клиентов в пределах UTC-даты', () => {
  const morning = new Date('2026-08-02T00:01:00Z');
  const evening = new Date('2026-08-02T23:59:00Z');
  const nextDay = new Date('2026-08-03T00:01:00Z');
  const first = dailyCourseSpec('normal', morning);
  assert.deepEqual(first, dailyCourseSpec('normal', evening));
  assert.equal(first.seed, dailySeed(morning));
  assert.notEqual(first.seed, dailyCourseSpec('normal', nextDay).seed);
});

test('испытание дня несёт один явный модификатор и одну цель', () => {
  const spec = dailyCourseSpec('chaos', at('2026-08-02'));
  assert.equal(spec.challenge, 'daily');
  assert.ok(
    DAILY_MODIFIERS.some(modifier => modifier.id === spec.modifier.id),
    'модификатор обязан быть из пула'
  );
  assert.ok(spec.modifier.label && spec.modifier.description, 'правило дня показывается игроку');
  assert.equal(spec.objectives.length, 1);
  assert.ok(spec.objectives[0].label, 'у цели есть подпись для экрана результатов');
});

test('daily presentation считает смену по той же UTC-границе, что и daily seed', () => {
  const beforeReset = new Date('2026-08-02T23:59:58.500Z');
  assert.equal(dailyResetRemaining(beforeReset), 1500);
  assert.equal(formatDailyCountdown(dailyResetRemaining(beforeReset)), '00:00:02');

  const atReset = new Date('2026-08-03T00:00:00.000Z');
  assert.equal(dailyResetRemaining(atReset), 86_400_000);
  assert.equal(formatDailyCountdown(dailyResetRemaining(atReset)), '24:00:00');
  assert.notEqual(dailySeed(beforeReset), dailySeed(atReset));
});

test('daily reward presentation читает декларативный streak unlock и не меняет entitlement', () => {
  const catalog = [
    { id: 'default', name: 'DEFAULT', unlock: { type: 'default' } },
    { id: 'daily-3', name: 'ТРИ ДНЯ', unlock: { type: 'daily', streak: 3 } },
    { id: 'daily-5', name: 'ПЯТЬ ДНЕЙ', unlock: { type: 'daily', streak: 5 } }
  ];

  let reward = nextDailyReward(catalog, { daily: { streak: 2, bestStreak: 2 } });
  assert.equal(reward.item.id, 'daily-3');
  assert.equal(reward.current, 2);
  assert.equal(reward.target, 3);

  // После старого рекорда прогресс следующей серии показывает текущую последовательность, а не
  // делает вид, будто best streak автоматически переносит два дня в новую серию.
  reward = nextDailyReward(catalog, { daily: { streak: 1, bestStreak: 3 } });
  assert.equal(reward.item.id, 'daily-5');
  assert.equal(reward.current, 1);
  assert.equal(reward.target, 5);

  reward = nextDailyReward(catalog, { daily: { streak: 2, bestStreak: 5 } });
  assert.equal(reward.complete, true);
  assert.equal(reward.item, null);
});

test('daily objective presentation показывает только сохранённый результат этой цели и этого дня', () => {
  const now = at('2026-08-02');
  const spec = dailyCourseSpec('normal', now);
  const objective = spec.objectives[0];
  const profile = {
    daily: { lastDay: spec.dayKey, streak: 4, bestStreak: 4 },
    dailyObjective: { dayKey: spec.dayKey, id: objective.id, complete: true }
  };

  assert.deepEqual(dailyObjectiveState(spec, profile), {
    id: objective.id,
    label: objective.label,
    current: 1,
    target: 1,
    attempted: true,
    complete: true
  });
  assert.equal(
    dailyObjectiveState(spec, {
      ...profile,
      dailyObjective: { ...profile.dailyObjective, dayKey: 'old' }
    }).current,
    0
  );

  const model = dailyPresentationModel({ difficulty: 'normal', now, profile, catalog: [] });
  assert.equal(model.dayKey, spec.dayKey);
  assert.equal(model.modifier.id, spec.modifier.id);
  assert.equal(model.objective.label, objective.label);
  assert.equal(model.runComplete, true);
});

// Главное, ради чего заведён пул. Раньше менялся только сид: трасса выглядела новой, а играть её
// приходилось совершенно одинаково — препятствия на 18% быстрее и «пройти без падений», каждый день.
test('правило дня меняется, а не только трасса', () => {
  const modifiers = new Set();
  const objectives = new Set();
  for (const day of days('2026-08-01', 40)) {
    modifiers.add(modifierForDay(day).id);
    objectives.add(objectiveForDay(day).id);
  }
  assert.equal(modifiers.size, DAILY_MODIFIERS.length, 'за сорок дней встречаются все модификаторы');
  assert.equal(objectives.size, DAILY_OBJECTIVES.length, 'и все цели');
});

test('два дня подряд правило не повторяется, а полный круг проходит без пропусков', () => {
  const sequence = days('2026-08-01', DAILY_MODIFIERS.length).map(day => modifierForDay(day).id);
  for (let i = 1; i < sequence.length; i++) {
    assert.notEqual(sequence[i], sequence[i - 1], `день ${i} повторяет предыдущий`);
  }
  assert.equal(new Set(sequence).size, DAILY_MODIFIERS.length, 'круг покрывает пул ровно один раз');

  const goals = days('2026-08-01', DAILY_OBJECTIVES.length).map(day => objectiveForDay(day).id);
  for (let i = 1; i < goals.length; i++) assert.notEqual(goals[i], goals[i - 1]);
  assert.equal(new Set(goals).size, DAILY_OBJECTIVES.length);
});

// Пул выбирается по номеру дня, а не по остатку от сида. Сид случайный: от него правило иногда
// выпадало бы два дня подряд, а иногда не появлялось бы месяцами.
test('сочетание модификатора и цели повторяется не чаще чем раз в сорок дней', () => {
  const pairs = days('2026-08-01', 40).map(day => `${modifierForDay(day).id}/${objectiveForDay(day).id}`);
  assert.equal(new Set(pairs).size, 40, 'все сорок сочетаний различны');
  assert.equal(dayNumber('2026-08-02') - dayNumber('2026-08-01'), 1, 'номер дня растёт на единицу');
});

test('каждый модификатор что-то действительно меняет', () => {
  const knobs = [
    'obstacleSpeed',
    'obstacleDirection',
    'knockback',
    'gravity',
    'jump',
    'dash',
    'dashCooldown',
    'groundGrip',
    'glide'
  ];
  for (const modifier of DAILY_MODIFIERS) {
    const touched = knobs.filter(key => modifier[key] !== undefined);
    assert.ok(touched.length > 0, `${modifier.id} ничего не меняет`);
    assert.ok(modifier.label, `${modifier.id} без подписи`);
    assert.ok(modifier.description, `${modifier.id} без описания`);
  }
  const ids = DAILY_MODIFIERS.map(modifier => modifier.id);
  assert.equal(new Set(ids).size, ids.length, 'идентификаторы модификаторов уникальны');
});

test('цели проверяются каждая по своему счётчику', () => {
  const perfect = { respawns: 0, time: 10_000, dashes: 0, hits: 0 };
  assert.equal(checkObjective({ id: 'no-falls' }, perfect), true);
  assert.equal(checkObjective({ id: 'no-falls' }, { ...perfect, respawns: 1 }), false);

  assert.equal(checkObjective({ id: 'few-falls', limit: 2 }, { ...perfect, respawns: 2 }), true);
  assert.equal(checkObjective({ id: 'few-falls', limit: 2 }, { ...perfect, respawns: 3 }), false);

  const timed = { id: 'under-time', targetMs: 12_000 };
  assert.equal(checkObjective(timed, perfect), true);
  assert.equal(checkObjective(timed, { ...perfect, time: 12_001 }), false);
  // Нулевое время — это не «уложился мгновенно», а отсутствие результата.
  assert.equal(checkObjective(timed, { ...perfect, time: 0 }), false);

  assert.equal(checkObjective({ id: 'no-dash' }, perfect), true);
  assert.equal(checkObjective({ id: 'no-dash' }, { ...perfect, dashes: 1 }), false);

  assert.equal(checkObjective({ id: 'no-hits' }, perfect), true);
  assert.equal(checkObjective({ id: 'no-hits' }, { ...perfect, hits: 1 }), false);
});

// Цель на время зависит от длины трассы: одно и то же число секунд на лёгкой и на хаосе означало бы
// разные задачи, и на длинной трассе цель была бы недостижима в принципе.
test('целевое время считается от эталона выбранной сложности', () => {
  const day = days('2026-08-01', 40).find(value => objectiveForDay(value).id === 'under-time');
  assert.ok(day, 'подготовка: в пуле должна быть цель на время');
  const easy = dailyCourseSpec('easy', at(day)).objectives[0];
  const chaos = dailyCourseSpec('chaos', at(day)).objectives[0];
  assert.ok(chaos.targetMs > easy.targetMs, 'на длинной трассе времени даётся больше');
  assert.equal(easy.targetMs, Math.round(coursePar('easy') * 1.05));
  assert.match(easy.label, /УЛОЖИТЬСЯ В \d\d:\d\d\.\d\d/, 'подпись цели несёт само время');
});

test('подпись цели совпадает с тем, что проверяется', () => {
  // Раньше экран результатов рисовал «БЕЗ ПАДЕНИЙ» для любой цели. С одной целью это было незаметно,
  // с пулом стало бы прямой ложью: игрок читает одно, а засчитывается другое.
  const labels = new Set();
  for (const day of days('2026-08-01', 40)) {
    const spec = dailyCourseSpec('normal', at(day));
    const [goal] = evaluateCourseObjectives(spec, { respawns: 0, time: 1, dashes: 0, hits: 0 });
    assert.equal(goal.id, spec.objectives[0].id);
    assert.equal(goal.label, spec.objectives[0].label);
    labels.add(goal.label);
  }
  assert.ok(labels.size > 1, 'подписи целей за сорок дней обязаны различаться');
});

test('цели оцениваются по итогам забега', () => {
  const spec = dailyCourseSpec('easy', at('2026-08-02'));
  const evaluated = evaluateCourseObjectives(spec, { respawns: 0, time: 1000, dashes: 0, hits: 0 });
  assert.equal(evaluated.length, 1);
  assert.equal(typeof evaluated[0].complete, 'boolean');
  assert.deepEqual(evaluateCourseObjectives({ ...spec, objectives: [] }, { respawns: 0 }), []);
});

// Модификатор описывает мир и управление в одних терминах, а Player берёт из него только своё.
// Обычная игра идёт тем же кодом с единичными множителями — отдельной ветки «без модификатора» нет.
test('настройка управления выводится из модификатора', () => {
  const plain = playerTuning(null);
  assert.deepEqual(plain, { gravity: 1, jump: 1, dash: 1, dashCooldown: 1, groundGrip: 1, glide: true });

  assert.equal(playerTuning({ glide: false }).glide, false);
  assert.equal(playerTuning({ gravity: 0.72, jump: 1.12 }).gravity, 0.72);
  assert.equal(playerTuning({ dash: 1.4, dashCooldown: 0.5 }).dashCooldown, 0.5);
  assert.equal(playerTuning({ groundGrip: 0.4 }).groundGrip, 0.4);

  // Мусор в модификаторе не должен превращаться в NaN внутри физики: там он расползётся по всем
  // последующим вычислениям и остановит игрока намертво.
  for (const bad of [0, -1, NaN, Infinity, 'быстро', null, undefined]) {
    assert.equal(playerTuning({ gravity: bad }).gravity, 1, `gravity=${String(bad)}`);
    assert.equal(playerTuning({ dash: bad }).dash, 1, `dash=${String(bad)}`);
  }

  // Каждый модификатор пула обязан давать пригодную настройку.
  for (const modifier of DAILY_MODIFIERS) {
    const tuning = playerTuning(modifier);
    for (const [key, value] of Object.entries(tuning)) {
      if (key === 'glide') assert.equal(typeof value, 'boolean');
      else assert.ok(Number.isFinite(value) && value > 0, `${modifier.id}.${key} = ${value}`);
    }
  }
});
