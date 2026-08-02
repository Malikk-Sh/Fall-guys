// Геометрия трассы приходит из общего с сервером модуля — см. shared/courseSpec.js.
// Здесь остаётся только то, что касается исключительно клиента: палитра, подача сложности,
// форматирование и генерация названий.
import {
  SEGMENT_LENGTH,
  FIRST_SEGMENT_CENTER,
  DIFFICULTY_SEGMENTS,
  createCourseSpec,
  safeDifficulty,
  spawnFor
} from '/shared/courseSpec.js';

export { SEGMENT_LENGTH, FIRST_SEGMENT_CENTER, safeDifficulty, spawnFor };

export const COLORS = {
  purple: 0x6546d8,
  purpleDark: 0x34206f,
  pink: 0xff4f91,
  yellow: 0xffd94b,
  cyan: 0x48dcda,
  mint: 0x58ebb8,
  orange: 0xff914d,
  blue: 0x55a7ff,
  white: 0xf7fbff,
  ink: 0x261653
};

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

export const DAILY_MODIFIER = Object.freeze({
  id: 'rush-hour',
  label: 'ЧАС ПИК',
  description: 'Препятствия движутся на 18% быстрее.',
  obstacleSpeed: 1.18
});

// Испытание дня использует общий UTC-сид, один явно показанный модификатор и дополнительную цель.
// Всё записано в spec, поэтому повтор, превью и результат не могут разойтись в трактовке правил.
export function dailyCourseSpec(difficulty = 'normal', date = new Date()) {
  return {
    ...createCourseSpec(dailySeed(date), difficulty),
    challenge: 'daily',
    dayKey: dailyDayKey(date),
    modifier: { ...DAILY_MODIFIER },
    objectives: ['no-falls']
  };
}

export function evaluateCourseObjectives(spec, { respawns = 0 } = {}) {
  return (spec?.objectives || []).map(id => ({
    id,
    complete: id === 'no-falls' ? respawns === 0 : false
  }));
}
export function formatTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const minutes = Math.floor(ms / 60000),
    seconds = Math.floor(ms / 1000) % 60,
    centis = Math.floor(ms / 10) % 100;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}
export function ordinal(value) {
  return String(Math.max(1, Math.floor(value)));
}
export function courseName(seed) {
  const a = ['Облачный', 'Звёздный', 'Сладкий', 'Турбо', 'Призменный', 'Кометный', 'Желейный', 'Ракетный'],
    b = ['круг', 'мост', 'карнавал', 'путь', 'спринт', 'микс', 'рывок', 'забег'];
  return `${a[seed % a.length]} ${b[(seed >>> 5) % b.length]}`.toUpperCase();
}
