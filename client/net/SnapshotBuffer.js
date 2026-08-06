// Буфер снапшотов с интерполяцией по времени.
//
// Проблема, которую он решает. Сервер рассылает состояние примерно 15 раз в секунду, а браузер рисует
// 60 и более кадров. Раньше клиент просто тянул удалённого игрока к последнему пришедшему пакету — из-за
// этого напарник всегда отставал на величину пинга и заметно дёргался на каждом пакете.
//
// Как правильно. Храним историю пакетов и рисуем удалённых игроков НЕ в текущем серверном времени, а
// намеренно немного в прошлом. Задержка подстраивается под интервал снапшотов и jitter сети, чтобы
// для момента отрисовки обычно были пакеты и до, и после него. При стабильной доставке задержка
// уменьшается, при скачках — плавно растёт вместо постоянных срывов в экстраполяцию.
//
// Если пакет потерялся и следующего ещё нет, на короткое время включается экстраполяция по скорости:
// у нас уже передаются vx и vz, раньше они использовались только для выбора анимации бега.
//
// Модуль намеренно не зависит от Three.js — так его можно тестировать в Node напрямую.

// На сколько отстаём от серверного времени при отрисовке. Чуть больше интервала рассылки (66 мс),
// чтобы даже при неравномерной доставке два соседних пакета почти всегда были на руках.
export const MIN_RENDER_DELAY_MS = 80;
export const MAX_RENDER_DELAY_MS = 220;
export const DEFAULT_RENDER_DELAY_MS = 100;

// Дольше этого не выдумываем позицию: лучше остановить персонажа, чем увести его в стену.
const MAX_EXTRAPOLATION_MS = 250;

// Сколько пакетов держим. При 15 Гц это около двух секунд истории — с запасом на всплески задержки.
const MAX_SNAPSHOTS = 32;

// Кратчайшая интерполяция угла: без неё поворот с 350° на 10° прокручивал бы персонажа на 340° назад.
export function lerpAngle(from, to, t) {
  let delta = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

export class SnapshotBuffer {
  constructor() {
    this.snapshots = [];
    this.intervals = [];
    this.jitters = [];
    this.lastTiming = null;
    this._renderDelay = DEFAULT_RENDER_DELAY_MS;
  }

  clear() {
    this.snapshots.length = 0;
    this.intervals.length = 0;
    this.jitters.length = 0;
    this.lastTiming = null;
    this._renderDelay = DEFAULT_RENDER_DELAY_MS;
  }

  get renderDelay() {
    return this._renderDelay;
  }

  targetRenderDelay() {
    if (!this.intervals.length) return DEFAULT_RENDER_DELAY_MS;
    const interval = percentile(this.intervals, 0.5);
    const jitter = percentile(this.jitters, 0.95);
    return Math.max(MIN_RENDER_DELAY_MS, Math.min(MAX_RENDER_DELAY_MS, interval + jitter * 1.5));
  }

  // `players` — массив состояний с полем `id`. Пакеты, пришедшие не по порядку, вставляются на своё
  // место: UDP-подобной доставки у WebSocket нет, но переупорядочивание всё равно возможно при
  // переподключении, а сортированный массив — предусловие для поиска соседей.
  push(serverTime, players, arrivedAt = null) {
    if (!Number.isFinite(serverTime) || !Array.isArray(players)) return;
    const byId = new Map();
    for (const state of players) if (state && state.id) byId.set(state.id, state);
    const entry = { time: serverTime, byId };

    const last = this.snapshots[this.snapshots.length - 1];
    if (!last || serverTime >= last.time) {
      this.snapshots.push(entry);
      if (Number.isFinite(arrivedAt)) this.recordTiming(serverTime, arrivedAt);
    } else {
      const index = this.snapshots.findIndex(item => item.time > serverTime);
      this.snapshots.splice(index < 0 ? this.snapshots.length : index, 0, entry);
    }

    while (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
  }

  recordTiming(serverTime, arrivedAt) {
    if (this.lastTiming) {
      const serverDelta = serverTime - this.lastTiming.serverTime;
      const arrivalDelta = arrivedAt - this.lastTiming.arrivedAt;
      if (serverDelta > 0 && arrivalDelta > 0) {
        this.intervals.push(serverDelta);
        this.jitters.push(Math.abs(arrivalDelta - serverDelta));
        while (this.intervals.length > MAX_SNAPSHOTS) this.intervals.shift();
        while (this.jitters.length > MAX_SNAPSHOTS) this.jitters.shift();
        const difference = this.targetRenderDelay() - this._renderDelay;
        // Буфер расширяется быстрее, чем сжимается: нехватку истории надо закрыть сразу, а резкое
        // уменьшение задержки визуально ускорило бы удалённого игрока.
        this._renderDelay += Math.max(-4, Math.min(12, difference));
      }
    }
    this.lastTiming = { serverTime, arrivedAt };
  }

  get latest() {
    return this.snapshots[this.snapshots.length - 1] || null;
  }

  // Список игроков, присутствующих в самом свежем пакете. По нему решается, кого создавать и удалять.
  activeIds() {
    const latest = this.latest;
    return latest ? [...latest.byId.keys()] : [];
  }

  // Состояние игрока `id` на момент `renderTime` (в серверном времени, уже со сдвигом RENDER_DELAY_MS).
  sample(id, renderTime) {
    if (!this.snapshots.length) return null;

    // Ищем пару соседних пакетов, между которыми лежит запрошенный момент.
    let before = null;
    let after = null;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const snapshot = this.snapshots[i];
      if (!snapshot.byId.has(id)) continue;
      if (snapshot.time <= renderTime) {
        before = snapshot;
        break;
      }
      after = snapshot;
    }

    // Есть оба соседа — обычный случай, честная интерполяция.
    if (before && after && after.time > before.time) {
      const t = (renderTime - before.time) / (after.time - before.time);
      return interpolate(before.byId.get(id), after.byId.get(id), Math.max(0, Math.min(1, t)));
    }

    // Запрошенный момент новее всей истории — пакеты запаздывают. Достраиваем по скорости.
    if (before) return extrapolate(before.byId.get(id), renderTime - before.time);

    // Запрошенный момент старше истории (игрок только что появился) — показываем первое известное.
    if (after) return { ...after.byId.get(id) };

    return null;
  }
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function interpolate(a, b, t) {
  return {
    ...b,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    ry: lerpAngle(a.ry || 0, b.ry || 0, t),
    vy: (a.vy || 0) + ((b.vy || 0) - (a.vy || 0)) * t
  };
}

function extrapolate(state, aheadMs) {
  const clamped = Math.max(0, Math.min(MAX_EXTRAPOLATION_MS, aheadMs)) / 1000;
  if (clamped <= 0) return { ...state };
  return {
    ...state,
    x: state.x + (state.vx || 0) * clamped,
    z: state.z + (state.vz || 0) * clamped,
    // На земле высота принадлежит платформе. В воздухе скорость уже известна, поэтому короткий
    // баллистический прогноз точнее зависания на последней полученной высоте.
    y:
      state.state === 'ground' || !Number.isFinite(state.vy)
        ? state.y
        : state.y + (state.vy || 0) * clamped - 0.5 * 22.5 * clamped * clamped,
    extrapolated: true
  };
}
