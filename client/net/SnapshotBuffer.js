// Буфер снапшотов с интерполяцией по времени.
//
// Проблема, которую он решает. Сервер рассылает состояние примерно 15 раз в секунду, а браузер рисует
// 60 и более кадров. Раньше клиент просто тянул удалённого игрока к последнему пришедшему пакету — из-за
// этого напарник всегда отставал на величину пинга и заметно дёргался на каждом пакете.
//
// Как правильно. Храним историю пакетов и рисуем удалённых игроков НЕ в текущем серверном времени, а
// намеренно на 100 мс в прошлом. Тогда для любого момента отрисовки почти всегда есть два пакета —
// до и после, — и позиция получается точной интерполяцией между ними, а не догадкой. Плата за это —
// постоянная задержка отображения в 100 мс, которая в кооперативной игре незаметна и полностью
// окупается плавностью.
//
// Если пакет потерялся и следующего ещё нет, на короткое время включается экстраполяция по скорости:
// у нас уже передаются vx и vz, раньше они использовались только для выбора анимации бега.
//
// Модуль намеренно не зависит от Three.js — так его можно тестировать в Node напрямую.

// На сколько отстаём от серверного времени при отрисовке. Чуть больше интервала рассылки (66 мс),
// чтобы даже при неравномерной доставке два соседних пакета почти всегда были на руках.
export const RENDER_DELAY_MS = 100;

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
  }

  clear() {
    this.snapshots.length = 0;
  }

  // `players` — массив состояний с полем `id`. Пакеты, пришедшие не по порядку, вставляются на своё
  // место: UDP-подобной доставки у WebSocket нет, но переупорядочивание всё равно возможно при
  // переподключении, а сортированный массив — предусловие для поиска соседей.
  push(serverTime, players) {
    if (!Number.isFinite(serverTime) || !Array.isArray(players)) return;
    const byId = new Map();
    for (const state of players) if (state && state.id) byId.set(state.id, state);
    const entry = { time: serverTime, byId };

    const last = this.snapshots[this.snapshots.length - 1];
    if (!last || serverTime >= last.time) {
      this.snapshots.push(entry);
    } else {
      const index = this.snapshots.findIndex(item => item.time > serverTime);
      this.snapshots.splice(index < 0 ? this.snapshots.length : index, 0, entry);
    }

    while (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
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

function interpolate(a, b, t) {
  return {
    ...b,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    ry: lerpAngle(a.ry || 0, b.ry || 0, t)
  };
}

function extrapolate(state, aheadMs) {
  const clamped = Math.max(0, Math.min(MAX_EXTRAPOLATION_MS, aheadMs)) / 1000;
  if (clamped <= 0) return { ...state };
  return {
    ...state,
    x: state.x + (state.vx || 0) * clamped,
    z: state.z + (state.vz || 0) * clamped,
    // По вертикали не экстраполируем: вертикальная скорость не передаётся, а гадать о прыжке
    // означает регулярно втыкать напарника в пол или подвешивать в воздухе.
    y: state.y,
    extrapolated: true
  };
}
