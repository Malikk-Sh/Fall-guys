// Проверка входящих сообщений по схемам из protocol.js.
//
// Раньше сервер разбирал сообщения вручную: где-то приводил тип, где-то доверял значению как есть.
// Так, например, `message.code` брался строкой без ограничения длины, а состояние игрока проверялось
// уже глубоко в игровой логике — то есть некорректные данные успевали пройти половину пути.
//
// Здесь проверка отделена от логики и выполняется механически по описанию. Плюс в том, что схема
// и документация — один и тот же объект, разойтись они не могут.

import { MESSAGE_SCHEMAS, RATE_LIMITS, VIOLATION_WEIGHTS } from './protocol.js';

function checkField(value, schema, path) {
  if (value === undefined || value === null) {
    if (schema.optional) return null;
    return `${path}: поле обязательно`;
  }

  switch (schema.kind) {
    case 'num':
      // Number.isFinite отсекает NaN и Infinity разом. Они особенно опасны в координатах:
      // NaN распространяется по всем последующим вычислениям и «заражает» состояние игрока.
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path}: ожидалось число`;
      if (value < schema.min || value > schema.max) {
        return `${path}: вне диапазона [${schema.min}, ${schema.max}]`;
      }
      return null;

    case 'str':
      if (typeof value !== 'string') return `${path}: ожидалась строка`;
      if (value.length > schema.max) return `${path}: длиннее ${schema.max} символов`;
      return null;

    case 'bool':
      if (typeof value !== 'boolean') return `${path}: ожидалось булево значение`;
      return null;

    case 'enum':
      if (!schema.values.includes(value)) return `${path}: недопустимое значение`;
      return null;

    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return `${path}: ожидался объект`;
      for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        const error = checkField(value[key], fieldSchema, `${path}.${key}`);
        if (error) return error;
      }
      return null;
    }

    default:
      return `${path}: неизвестный тип схемы`;
  }
}

// Возвращает { ok: true } либо { ok: false, reason, detail }, где reason — ключ из VIOLATION_WEIGHTS.
export function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, reason: 'INVALID_SCHEMA', detail: 'сообщение не является объектом' };
  }
  if (typeof message.type !== 'string') {
    return { ok: false, reason: 'INVALID_SCHEMA', detail: 'отсутствует поле type' };
  }

  const schema = MESSAGE_SCHEMAS[message.type];
  if (!schema) {
    return { ok: false, reason: 'UNKNOWN_TYPE', detail: `неизвестный тип «${message.type}»` };
  }

  for (const [key, fieldSchema] of Object.entries(schema)) {
    const error = checkField(message[key], fieldSchema, key);
    if (error) return { ok: false, reason: 'INVALID_SCHEMA', detail: error };
  }

  return { ok: true };
}

// Ограничитель частоты по типам сообщений, скользящее окно на кольцевом буфере отметок времени.
//
// Скользящее окно, а не простой счётчик с обнулением: со счётчиком игрок мог бы отправить лимит в
// конце одного окна и сразу столько же в начале следующего, то есть двойную норму за миг.
export class RateLimiter {
  constructor(limits = RATE_LIMITS) {
    this.limits = limits;
    this.hits = new Map();
  }

  // true — сообщение допустимо, false — превышена частота.
  allow(type, now = Date.now()) {
    const limit = this.limits[type];
    if (!limit) return true;
    const [max, windowMs] = limit;

    let timestamps = this.hits.get(type);
    if (!timestamps) {
      timestamps = [];
      this.hits.set(type, timestamps);
    }

    // Выбрасываем всё, что вышло за окно. Массив отсортирован по возрастанию, поэтому достаточно
    // срезать начало.
    const cutoff = now - windowMs;
    let firstValid = 0;
    while (firstValid < timestamps.length && timestamps[firstValid] <= cutoff) firstValid++;
    if (firstValid > 0) timestamps.splice(0, firstValid);

    if (timestamps.length >= max) return false;
    timestamps.push(now);
    return true;
  }

  reset() {
    this.hits.clear();
  }
}

// Счётчик нарушений с затуханием.
//
// Затухание принципиально: у игрока с нестабильной сетью нарушения частоты будут случаться и без
// злого умысла. Без затухания они копились бы всю сессию и рано или поздно выкинули бы честного
// игрока из игры.
export class ViolationTracker {
  // `now` передаётся параметром, а не читается из часов внутри: иначе класс, у которого все
  // остальные методы принимают время аргументом, в конструкторе брал бы его сам, и в тестах с
  // условной шкалой времени затухание считалось бы от реальной даты — то есть не работало бы.
  constructor({ threshold, decayPerMinute, now = Date.now() }) {
    this.threshold = threshold;
    this.decayPerMinute = decayPerMinute;
    this.score = 0;
    this.lastUpdate = now;
  }

  decay(now) {
    const minutes = (now - this.lastUpdate) / 60_000;
    if (minutes > 0) {
      this.score = Math.max(0, this.score - minutes * this.decayPerMinute);
      this.lastUpdate = now;
    }
  }

  // Возвращает true, если порог превышен и соединение пора закрывать.
  add(reason, now = Date.now()) {
    this.decay(now);
    this.score += VIOLATION_WEIGHTS[reason] ?? 1;
    return this.score >= this.threshold;
  }

  current(now = Date.now()) {
    this.decay(now);
    return this.score;
  }
}
