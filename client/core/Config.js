// Геометрия трассы приходит из общего с сервером модуля — см. shared/courseSpec.js.
// Здесь остаётся только то, что касается исключительно клиента: палитра, подача сложности,
// форматирование и генерация названий.
import {
  SEGMENT_LENGTH,
  FIRST_SEGMENT_CENTER,
  SEGMENT_WIDTH,
  START_PLATFORM,
  DIFFICULTY_SEGMENTS,
  createCourseSpec,
  safeDifficulty,
  spawnFor
} from '/shared/courseSpec.js';

import { modifierForDay, objectiveForDay, materializeObjective, checkObjective } from './dailyModifiers.js';

export { SEGMENT_LENGTH, FIRST_SEGMENT_CENTER, SEGMENT_WIDTH, START_PLATFORM, safeDifficulty, spawnFor };
export { DAILY_MODIFIERS, DAILY_OBJECTIVES, modifierForDay, objectiveForDay } from './dailyModifiers.js';

// Палитра переехала в shared/ вместе с расстановкой сегментов; здесь она только
// переэкспортируется, чтобы клиентские модули не меняли свои импорты.
export { COLORS } from '/shared/palette.js';

// Число сегментов берётся из общего модуля, чтобы не разойтись с сервером;
// скорость препятствий и целевое время — чисто клиентская настройка подачи.
export const DIFFICULTIES = {
  easy: { label: 'Легко', segments: DIFFICULTY_SEGMENTS.easy, speed: 0.82, parPerSegment: 15 },
  normal: { label: 'Забег', segments: DIFFICULTY_SEGMENTS.normal, speed: 1, parPerSegment: 13 },
  chaos: { label: 'Хаос', segments: DIFFICULTY_SEGMENTS.chaos, speed: 1.2, parPerSegment: 12 }
};

export function hashString(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function dailySeed(date = new Date()) {
  const day = dailyDayKey(date);
  return hashString(`wobble-${day}`);
}
export function dailyDayKey(date = new Date()) {
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    .map((part, index) => (index ? String(part).padStart(2, '0') : String(part)))
    .join('-');
}
export function randomSeed() {
  return (crypto?.getRandomValues?.(new Uint32Array(1))[0] ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
}
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const courseSpec = createCourseSpec;

// Эталонное время трассы: по нему выдаются медали и от него считается цель «уложиться во время».
export function coursePar(difficulty = 'normal') {
  const tuning = DIFFICULTIES[safeDifficulty(difficulty)];
  return tuning.parPerSegment * tuning.segments * 1000;
}

// Испытание дня использует общий UTC-сид, модификатор и цель из пула, выбранные по номеру дня.
// Всё записано в spec, поэтому повтор, превью и результат не могут разойтись в трактовке правил.
export function dailyCourseSpec(difficulty = 'normal', date = new Date()) {
  const dayKey = dailyDayKey(date);
  const modifier = modifierForDay(dayKey);
  const objective = materializeObjective(objectiveForDay(dayKey), coursePar(difficulty));
  return {
    ...createCourseSpec(dailySeed(date), difficulty),
    challenge: 'daily',
    dayKey,
    modifier: { ...modifier },
    // Цель уже развёрнута: целевое время зависит от сложности, и считать его заново на экране
    // результатов значило бы держать это правило в двух местах.
    objectives: [
      {
        ...objective,
        // Подпись с числом собирается здесь, где есть formatTime. Модуль пула о форматировании
        // времени не знает и знать не должен.
        label:
          objective.id === 'under-time' ? `УЛОЖИТЬСЯ В ${formatTime(objective.targetMs)}` : objective.label
      }
    ]
  };
}

export function evaluateCourseObjectives(spec, progress = {}) {
  return (spec?.objectives || []).map(objective => ({
    id: objective.id,
    label: objective.label,
    complete: checkObjective(objective, progress)
  }));
}
export function formatTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const minutes = Math.floor(ms / 60000),
    seconds = Math.floor(ms / 1000) % 60,
    centis = Math.floor(ms / 10) % 100;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}
// Отставание от соседа сверху. Формат отличается от formatTime намеренно: «+1.24» читается как
// разрыв, а «00:01.24» — как ещё одно время, и в строке рядом с собственным результатом их легко
// перепутать.
export function formatGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = ms / 1000;
  return seconds >= 60
    ? `+${Math.floor(seconds / 60)}:${String(Math.floor(seconds) % 60).padStart(2, '0')}`
    : `+${seconds.toFixed(2)}`;
}
export function ordinal(value) {
  return String(Math.max(1, Math.floor(value)));
}
export function courseName(seed) {
  const a = ['Облачный', 'Звёздный', 'Сладкий', 'Турбо', 'Призменный', 'Кометный', 'Желейный', 'Ракетный'],
    b = ['круг', 'мост', 'карнавал', 'путь', 'спринт', 'микс', 'рывок', 'забег'];
  return `${a[seed % a.length]} ${b[(seed >>> 5) % b.length]}`.toUpperCase();
}
