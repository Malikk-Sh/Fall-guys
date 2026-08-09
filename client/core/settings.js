// Настройки управления и доступности.
//
// Каждая настройка объявлена ровно один раз — здесь, вместе со своим типом, границами и значением
// по умолчанию. Чтение и запись идут через эту же схему, поэтому невозможного значения в игре не
// окажется: чувствительность −9999 или размер джойстика «true» превратятся в умолчание, а не в
// сломанную камеру. Настройки живут в localStorage, то есть их правит кто угодно и они переживают
// смену версии игры, — доверять их содержимому нельзя.
//
// Почему схема, а не россыпь ключей вроде `wobble-sensitivity`. Настроек здесь одиннадцать, и
// каждая нужна сразу в нескольких местах: ввод, камера, звук, разметка, стили. При россыпи любое
// добавление означало бы правку в пяти файлах и новую возможность разойтись в умолчаниях. Здесь
// добавление — одна строка в SCHEMA, а экран настроек строится по ней сам.

const STORAGE_KEY = 'wobble-controls-v1';

// Действия, которым можно назначить клавиши. Порядок — как на экране настроек.
export const ACTIONS = Object.freeze([
  { id: 'forward', label: 'Вперёд' },
  { id: 'back', label: 'Назад' },
  { id: 'left', label: 'Влево' },
  { id: 'right', label: 'Вправо' },
  { id: 'jump', label: 'Прыжок' },
  { id: 'dive', label: 'Рывок' },
  { id: 'cameraLeft', label: 'Камера влево' },
  { id: 'cameraRight', label: 'Камера вправо' },
  { id: 'recenter', label: 'Камера за спину' },
  { id: 'cameraMode', label: 'Режим камеры' }
]);

// По две клавиши на действие там, где это привычно: WASD и стрелки исторически работают обе, и
// отнимать вторую раскладку ради единообразия значило бы ухудшить игру ради красоты таблицы.
export const DEFAULT_BINDINGS = Object.freeze({
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  dive: ['ShiftLeft', 'ShiftRight'],
  cameraLeft: ['KeyQ'],
  cameraRight: ['KeyE'],
  recenter: ['KeyR'],
  cameraMode: ['KeyC']
});

// Больше двух клавиш на действие не нужно, а неограниченный список — это способ раздуть
// сохранённые настройки чужим мусором.
const MAX_KEYS_PER_ACTION = 2;

// Код клавиши из KeyboardEvent.code. Проверяется формой, а не списком: раскладок и клавиатур
// слишком много, чтобы перечислять, а вот «строка разумной длины из латиницы и цифр» отсекает и
// мусор, и попытку положить сюда объект.
const KEY_CODE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;

export const SCHEMA = Object.freeze({
  // Сторона, с которой находится джойстик. Кнопки действий уезжают на противоположную.
  hand: { type: 'enum', values: ['left', 'right'], default: 'left' },

  // Размер джойстика в пикселях и его непрозрачность в процентах. Оба про одно: экранное
  // управление занимает место на экране, и сколько именно — решает не разработчик, а тот, у кого
  // этот экран в руках.
  stickSize: { type: 'range', min: 96, max: 200, step: 4, default: 132, unit: 'px' },
  stickOpacity: { type: 'range', min: 20, max: 100, step: 5, default: 100, unit: '%' },

  // Фиксированный джойстик всегда на одном месте; плавающий появляется там, где палец коснулся
  // экрана. Плавающий удобнее в движении и хуже, когда хочется найти джойстик не глядя.
  stickMode: { type: 'enum', values: ['fixed', 'floating'], default: 'fixed' },

  // Чувствительность обзора в процентах от нынешней. 100 — ровно то, что было до этой настройки.
  lookSensitivity: { type: 'range', min: 25, max: 250, step: 5, default: 100, unit: '%' },
  invertX: { type: 'boolean', default: false },
  invertY: { type: 'boolean', default: false },

  // Сила тряски экрана в процентах. Ноль выключает её полностью, не трогая остальную анимацию:
  // тряска укачивает заметно чаще, чем движение интерфейса, и уводить её вместе с ним неправильно.
  shake: { type: 'range', min: 0, max: 100, step: 10, default: 100, unit: '%' },

  // Вибрация со своей силой и своим нулём — независимо от звука. Телефон в беззвучном режиме
  // остаётся без единого сигнала обратной связи, а глухому игроку вибрация нужна тем более.
  // Привязывать её к громкости значило бы отнимать отклик у тех, кому он нужнее всего.
  haptics: { type: 'range', min: 0, max: 100, step: 10, default: 60, unit: '%' },

  // Уменьшенная анимация: авто — как просит система, остальные два значения её переопределяют.
  // Только системного флага мало в обе стороны: его выставляют ради всей ОС и забывают, а нужным
  // он оказывается именно в игре — и наоборот.
  motion: { type: 'enum', values: ['auto', 'full', 'reduced'], default: 'auto' },

  // Масштаб интерфейса в процентах. Растёт только вверх: HUD и так собран под мелкие экраны, и
  // уменьшать его — способ сделать нечитаемым.
  uiScale: { type: 'range', min: 100, max: 160, step: 10, default: 100, unit: '%' },

  keys: { type: 'keys', default: DEFAULT_BINDINGS }
});

export function defaults() {
  return sanitize({});
}

// Имена и представление настроек в CSS. Держатся рядом со схемой, чтобы стили и код не разъезжались.
const CSS_NAMES = Object.freeze({
  stickSize: '--stick-size',
  stickOpacity: '--stick-opacity',
  uiScale: '--ui-scale'
});

function cssName(name) {
  return CSS_NAMES[name];
}

// Пиксели уходят с единицей, проценты — долей: CSS умеет умножать на 1.3, но не на «130%».
function cssValue(name, value) {
  return SCHEMA[name].unit === 'px' ? `${value}px` : String(value / 100);
}

function clampRange(value, rule) {
  const number = Number(value);
  if (!Number.isFinite(number)) return rule.default;
  // Округление по шагу: значение, пришедшее из чужого хранилища, не обязано быть кратным, а
  // регулятор на экране умеет вставать только по шагу — иначе ползунок дёргался бы при открытии.
  const stepped = Math.round((number - rule.min) / rule.step) * rule.step + rule.min;
  return Math.min(rule.max, Math.max(rule.min, stepped));
}

function sanitizeKeys(raw) {
  const result = {};
  for (const { id } of ACTIONS) {
    const list = Array.isArray(raw?.[id]) ? raw[id] : DEFAULT_BINDINGS[id];
    const clean = [];
    for (const code of list) {
      if (typeof code !== 'string' || !KEY_CODE.test(code)) continue;
      if (!clean.includes(code)) clean.push(code);
      if (clean.length === MAX_KEYS_PER_ACTION) break;
    }
    // Действие без единой клавиши — это действие, которое нельзя выполнить. Сохранённая пустота
    // (промах в интерфейсе, чужой мусор) не должна отбирать у игрока прыжок навсегда.
    result[id] = clean.length ? clean : [...DEFAULT_BINDINGS[id]];
  }
  return result;
}

// Приводит что угодно к полному и осмысленному набору настроек.
export function sanitize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const result = {};
  for (const [key, rule] of Object.entries(SCHEMA)) {
    const value = source[key];
    if (rule.type === 'enum') result[key] = rule.values.includes(value) ? value : rule.default;
    else if (rule.type === 'boolean') result[key] = typeof value === 'boolean' ? value : rule.default;
    else if (rule.type === 'range') result[key] = clampRange(value, rule);
    else if (rule.type === 'keys') result[key] = sanitizeKeys(value);
  }
  return result;
}

export function readSettings(storage = globalThis.localStorage) {
  try {
    return sanitize(JSON.parse(storage?.getItem(STORAGE_KEY) || 'null'));
  } catch {
    return sanitize({});
  }
}

export function writeSettings(values, storage = globalThis.localStorage) {
  const clean = sanitize(values);
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Приватный режим браузера и переполненное хранилище — не повод падать: настройки уже
    // применены к текущей сессии, потеряется только их память между запусками.
  }
  return clean;
}

// Клавиша уже занята другим действием? Одна клавиша на два действия — это не «гибко», а
// «нажимаешь прыжок, срабатывает рывок».
export function conflictFor(values, action, code) {
  for (const { id } of ACTIONS) {
    if (id !== action && values.keys[id].includes(code)) return id;
  }
  return null;
}

export class Settings {
  // `navigator` передаётся, а не берётся из глобали: вибрация — единственное здесь, что зависит от
  // устройства, и тест обязан уметь сыграть и «телефон умеет», и «не умеет». В браузере значение
  // по умолчанию как раз то, что нужно.
  constructor({
    storage = globalThis.localStorage,
    root = globalThis.document,
    navigator = globalThis.navigator
  } = {}) {
    this.storage = storage;
    this.root = root;
    this.navigator = navigator;
    this.values = readSettings(storage);
    this.listeners = new Set();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (!Object.hasOwn(SCHEMA, key)) return this.values[key];
    this.values = writeSettings({ ...this.values, [key]: value }, this.storage);
    this.apply();
    this.notify(key);
    return this.values[key];
  }

  // Назначение клавиши. Конфликт разрешается отбиранием: клавиша уходит новому действию, а у
  // старого остаётся то, что было. Отказать вместо этого — значит заставить игрока разбирать
  // раскладку в правильном порядке; молча оставить обе — значит сломать оба действия.
  bind(action, code) {
    if (!ACTIONS.some(item => item.id === action) || !KEY_CODE.test(String(code))) return this.values.keys;
    const keys = {};
    for (const { id } of ACTIONS) keys[id] = this.values.keys[id].filter(item => item !== code);
    keys[action] = [code, ...keys[action]].slice(0, MAX_KEYS_PER_ACTION);
    this.values = writeSettings({ ...this.values, keys }, this.storage);
    this.notify('keys');
    return this.values.keys;
  }

  reset() {
    this.values = writeSettings({}, this.storage);
    this.apply();
    this.notify(null);
    return this.values;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(key) {
    for (const listener of [...this.listeners]) listener(this.values, key);
  }

  // Уменьшать ли анимацию прямо сейчас. `auto` спрашивает систему при каждом обращении, а не
  // один раз при загрузке: настройку доступности меняют посреди работы именно тогда, когда она
  // понадобилась.
  get reducedMotion() {
    if (this.values.motion === 'reduced') return true;
    if (this.values.motion === 'full') return false;
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  // Множитель тряски. Уменьшенная анимация выключает её целиком независимо от регулятора:
  // системная просьба «поменьше движения» сильнее, чем забытое положение ползунка.
  get shakeScale() {
    return this.reducedMotion ? 0 : this.values.shake / 100;
  }

  get lookScale() {
    return this.values.lookSensitivity / 100;
  }

  // Сколько миллисекунд вибрировать на событие силой `strength` (0…1).
  //
  // Возвращает 0, когда вибрация выключена или не поддерживается, — вызывающему не приходится
  // знать ни про то, ни про другое.
  vibrationFor(strength = 1) {
    if (!this.values.haptics || !this.navigator?.vibrate) return 0;
    const scale = this.values.haptics / 100;
    return Math.round(Math.min(60, Math.max(0, strength) * 55 * scale));
  }

  // Вибрация на игровое событие. Возвращает, случилась ли она, — по этому же значению её проверяет
  // тест, не подсматривая внутрь.
  vibrate(strength = 1) {
    const duration = this.vibrationFor(strength);
    if (!duration) return false;
    try {
      this.navigator.vibrate(duration);
    } catch {
      // Часть браузеров запрещает вибрацию до первого касания страницы и бросает исключение.
      // Отклик — не то, ради чего стоит ронять кадр.
      return false;
    }
    return true;
  }

  // Переносит настройки в стили и разметку. Всё, что можно решить на стороне CSS, решается там:
  // раскладка, размеры и масштаб не должны пересчитываться каждый кадр в JS.
  apply() {
    const body = this.root?.body;
    if (!body) return;
    const style = body.style;
    // Переменная выставляется, только когда игрок действительно что-то выбрал.
    //
    // Иначе умолчание в 132 пикселя, записанное на body, перебило бы адаптивные правила: на узком
    // телефоне джойстик задан меньше именно потому, что экран узкий, а инлайновый стиль сильнее
    // любого медиазапроса. Тронутая настройка обязана побеждать брейкпоинт, нетронутая — нет.
    const useDefault = (name, value) => {
      if (value === SCHEMA[name].default) style.removeProperty(cssName(name));
      else style.setProperty(cssName(name), cssValue(name, value));
    };
    useDefault('stickSize', this.values.stickSize);
    useDefault('stickOpacity', this.values.stickOpacity);
    useDefault('uiScale', this.values.uiScale);
    body.dataset.hand = this.values.hand;
    body.dataset.stick = this.values.stickMode;
    body.classList.toggle('reduced-motion', this.reducedMotion);
    body.classList.toggle('large-ui', this.values.uiScale > 100);
  }
}
