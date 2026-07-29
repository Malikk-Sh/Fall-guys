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
  easy: { label: 'Breezy', segments: DIFFICULTY_SEGMENTS.easy, speed: 0.82, parPerSegment: 15 },
  normal: { label: 'Rush', segments: DIFFICULTY_SEGMENTS.normal, speed: 1, parPerSegment: 13 },
  chaos: { label: 'Mayhem', segments: DIFFICULTY_SEGMENTS.chaos, speed: 1.2, parPerSegment: 12 }
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
  const day = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
  return hashString(`wobble-${day}`);
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
export function formatTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const minutes = Math.floor(ms / 60000),
    seconds = Math.floor(ms / 1000) % 60,
    centis = Math.floor(ms / 10) % 100;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}
export function ordinal(value) {
  const n = Math.max(1, Math.floor(value)),
    mod = n % 100;
  if (mod >= 11 && mod <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}
export function courseName(seed) {
  const a = ['Cloud', 'Nova', 'Candy', 'Turbo', 'Prism', 'Comet', 'Jelly', 'Rocket'],
    b = ['Circuit', 'Causeway', 'Carnival', 'Skyway', 'Sprint', 'Shuffle', 'Dash', 'Run'];
  return `${a[seed % a.length]} ${b[(seed >>> 5) % b.length]}`.toUpperCase();
}
