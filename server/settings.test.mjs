// Настройки управления: проверка значений, конфликты клавиш, приоритет доступности.
//
// Настройки лежат в localStorage — то есть в месте, куда пишет кто угодно и что угодно, и где
// остаются значения от прошлых версий игры. Поэтому проверяется не «сохранилось и прочиталось»,
// а «игра не ломается от чужого содержимого хранилища».

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Settings,
  SCHEMA,
  ACTIONS,
  DEFAULT_BINDINGS,
  defaults,
  sanitize,
  readSettings,
  writeSettings,
  conflictFor
} from '../client/core/settings.js';

// Хранилище в памяти: настоящий localStorage в Node недоступен, а подменять его глобально ради
// теста — способ сломать соседние наборы.
function storage(initial = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    get raw() {
      return value;
    }
  };
}

test('умолчания попадают в объявленные границы и типы', () => {
  const values = defaults();
  for (const [key, rule] of Object.entries(SCHEMA)) {
    if (rule.type === 'range') {
      assert.ok(values[key] >= rule.min && values[key] <= rule.max, `${key} вне границ`);
      assert.equal((values[key] - rule.min) % rule.step, 0, `${key} не кратен шагу`);
    } else if (rule.type === 'enum') {
      assert.ok(rule.values.includes(values[key]), `${key} не из списка`);
    } else if (rule.type === 'boolean') {
      assert.equal(typeof values[key], 'boolean');
    }
  }
  assert.deepEqual(values.keys, { ...DEFAULT_BINDINGS });
});

test('мусор в хранилище заменяется умолчаниями, а не роняет игру', () => {
  const values = sanitize({
    hand: 'вверх',
    stickSize: -9999,
    stickOpacity: 'много',
    lookSensitivity: Infinity,
    invertY: 'да',
    shake: NaN,
    uiScale: 10_000,
    motion: null,
    keys: 'ничего'
  });
  assert.equal(values.hand, SCHEMA.hand.default);
  assert.equal(values.stickSize, SCHEMA.stickSize.min, 'слишком малое поджимается к границе');
  assert.equal(values.uiScale, SCHEMA.uiScale.max, 'слишком большое — к другой');
  assert.equal(values.stickOpacity, SCHEMA.stickOpacity.default);
  assert.equal(values.lookSensitivity, SCHEMA.lookSensitivity.default, 'бесконечность — не число');
  assert.equal(values.invertY, false, 'строка «да» булевым значением не является');
  assert.deepEqual(values.keys, { ...DEFAULT_BINDINGS });
});

test('битый JSON читается как чистые настройки', () => {
  assert.deepEqual(readSettings(storage('{не json')), defaults());
  assert.deepEqual(readSettings(storage(null)), defaults());
  assert.deepEqual(readSettings(undefined), defaults(), 'без хранилища тоже');
});

test('сохранённое переживает перезагрузку', () => {
  const box = storage();
  writeSettings({ ...defaults(), hand: 'right', lookSensitivity: 150 }, box);
  const back = readSettings(box);
  assert.equal(back.hand, 'right');
  assert.equal(back.lookSensitivity, 150);
});

test('недоступное хранилище не мешает играть', () => {
  const broken = {
    getItem: () => {
      throw new Error('приватный режим');
    },
    setItem: () => {
      throw new Error('квота');
    }
  };
  const settings = new Settings({ storage: broken, root: null });
  assert.deepEqual(settings.values, defaults());
  assert.equal(settings.set('hand', 'right'), 'right', 'настройка применяется к текущей сессии');
});

// Одна клавиша на два действия — это не гибкость, а «жмёшь прыжок, срабатывает рывок».
test('назначенная клавиша отбирается у прежнего действия', () => {
  const settings = new Settings({ storage: storage(), root: null });
  assert.equal(conflictFor(settings.values, 'jump', 'KeyW'), 'forward', 'подготовка: клавиша занята');

  const keys = settings.bind('jump', 'KeyW');
  assert.ok(keys.jump.includes('KeyW'), 'новое действие клавишу получило');
  assert.ok(!keys.forward.includes('KeyW'), 'у прежнего её больше нет');
  assert.ok(keys.forward.length > 0, 'но само действие без клавиш не осталось');
  assert.equal(conflictFor(settings.values, 'jump', 'KeyW'), null);
});

test('действие не остаётся без единой клавиши', () => {
  const values = sanitize({ keys: { jump: [], dive: ['не-код'], forward: ['KeyI', 'KeyO', 'KeyP'] } });
  assert.deepEqual(values.keys.jump, DEFAULT_BINDINGS.jump, 'пустой список — как отсутствующий');
  assert.deepEqual(values.keys.dive, DEFAULT_BINDINGS.dive, 'единственный мусорный код — как пустота');
  assert.equal(values.keys.forward.length, 2, 'больше двух клавиш на действие не хранится');
});

test('перебор клавиш вытесняет самую старую, а не копится', () => {
  const settings = new Settings({ storage: storage(), root: null });
  settings.bind('jump', 'KeyZ');
  settings.bind('jump', 'KeyX');
  const keys = settings.bind('jump', 'KeyV');
  assert.equal(keys.jump.length, 2);
  assert.equal(keys.jump[0], 'KeyV', 'последняя назначенная — первая в списке');
});

test('сброс возвращает всё разом', () => {
  const settings = new Settings({ storage: storage(), root: null });
  settings.set('hand', 'right');
  settings.set('uiScale', 140);
  settings.bind('jump', 'KeyZ');
  assert.deepEqual(settings.reset(), defaults());
});

// Просьба системы «поменьше движения» сильнее забытого положения ползунка: иначе настройка
// доступности выполнялась бы наполовину, что хуже, чем не выполняться вовсе.
test('уменьшенная анимация выключает тряску поверх регулятора', () => {
  const settings = new Settings({ storage: storage(), root: null });
  settings.set('shake', 100);
  settings.set('motion', 'reduced');
  assert.equal(settings.reducedMotion, true);
  assert.equal(settings.shakeScale, 0, 'ползунок на максимуме, но тряски нет');

  settings.set('motion', 'full');
  assert.equal(settings.shakeScale, 1);
  settings.set('shake', 30);
  assert.equal(Math.round(settings.shakeScale * 100), 30, 'регулятор работает сам по себе');
});

test('явный выбор сильнее системного, а «авто» его слушает', () => {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  try {
    const settings = new Settings({ storage: storage(), root: null });
    assert.equal(settings.reducedMotion, true, 'авто следует за системой');
    settings.set('motion', 'full');
    assert.equal(settings.reducedMotion, false, 'явное «полная анимация» перевешивает систему');
  } finally {
    globalThis.matchMedia = original;
  }
});

// Вибрация — единственная обратная связь на беззвучном телефоне и у глухого игрока. Привязать её
// к громкости значило бы отнять отклик именно у тех, кому он нужнее всего.
test('вибрация не зависит от звука и молчит там, где её нет', () => {
  const buzzes = [];
  const settings = new Settings({
    storage: storage(),
    root: null,
    navigator: { vibrate: ms => buzzes.push(ms) }
  });

  settings.set('haptics', 100);
  const strong = settings.vibrationFor(1);
  assert.ok(strong > 0, 'при включённой вибрации длительность положительна');
  assert.ok(settings.vibrationFor(0.2) < strong, 'слабое событие — короче');
  assert.equal(settings.vibrate(1), true);
  assert.deepEqual(buzzes, [strong]);

  settings.set('haptics', 0);
  assert.equal(settings.vibrationFor(1), 0, 'ноль на регуляторе выключает полностью');
  assert.equal(settings.vibrate(1), false);
  assert.equal(buzzes.length, 1, 'выключенная вибрация до устройства не доходит');
});

test('устройство без вибрации и запрет браузера не роняют кадр', () => {
  const mute = new Settings({ storage: storage(), root: null, navigator: {} });
  assert.equal(mute.vibrationFor(1), 0, 'нет vibrate — ноль, а не ошибка');
  assert.equal(mute.vibrate(1), false);

  const forbidden = new Settings({
    storage: storage(),
    root: null,
    navigator: {
      vibrate: () => {
        throw new Error('требуется жест пользователя');
      }
    }
  });
  assert.equal(forbidden.vibrate(1), false, 'исключение поглощается, игра продолжается');
});

function fakeBody() {
  const properties = new Map();
  const classes = new Set();
  return {
    properties,
    classes,
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: name => properties.delete(name)
    },
    dataset: {},
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) }
  };
}

test('настройки переносятся в стили и разметку', () => {
  const body = fakeBody();
  const settings = new Settings({ storage: storage(), root: { body } });
  settings.set('hand', 'right');
  settings.set('stickSize', 160);
  settings.set('uiScale', 130);
  settings.set('stickMode', 'floating');
  settings.set('motion', 'reduced');

  assert.equal(body.dataset.hand, 'right');
  assert.equal(body.dataset.stick, 'floating');
  assert.equal(body.properties.get('--stick-size'), '160px');
  assert.equal(body.properties.get('--ui-scale'), '1.3', 'проценты уходят в CSS долей');
  assert.ok(body.classes.has('large-ui'));
  assert.ok(body.classes.has('reduced-motion'));

  settings.set('uiScale', 100);
  assert.ok(!body.classes.has('large-ui'), 'обычный масштаб класс снимает');
});

// Инлайновый стиль на body сильнее любого медиазапроса. Записывай его всегда — и джойстик на
// узком телефоне стал бы размером с планшетный, потому что «умолчание» тоже значение.
test('нетронутая настройка не перебивает адаптивные правила', () => {
  const body = fakeBody();
  const settings = new Settings({ storage: storage(), root: { body } });
  settings.apply();
  assert.equal(body.properties.has('--stick-size'), false, 'умолчание в стили не пишется');

  settings.set('stickSize', 160);
  assert.equal(body.properties.get('--stick-size'), '160px', 'выбор игрока — пишется');

  settings.set('stickSize', SCHEMA.stickSize.default);
  assert.equal(body.properties.has('--stick-size'), false, 'возврат к умолчанию снимает переменную');
});

test('подписчик узнаёт, что именно изменилось', () => {
  const settings = new Settings({ storage: storage(), root: null });
  const seen = [];
  const stop = settings.subscribe((_values, key) => seen.push(key));
  settings.set('hand', 'right');
  settings.bind('jump', 'KeyZ');
  settings.reset();
  stop();
  settings.set('hand', 'right');
  assert.deepEqual(seen, ['hand', 'keys', null], 'сброс сообщается как «изменилось всё»');
});

test('неизвестная настройка игнорируется, а не заводится', () => {
  const settings = new Settings({ storage: storage(), root: null });
  settings.set('вимана', 42);
  assert.ok(!Object.hasOwn(settings.values, 'вимана'));
  assert.deepEqual(Object.keys(settings.values).sort(), Object.keys(SCHEMA).sort());
});

test('у каждого действия есть подпись для экрана настроек', () => {
  for (const action of ACTIONS) {
    assert.ok(action.label && action.label.trim(), `${action.id} без подписи`);
    assert.ok(DEFAULT_BINDINGS[action.id]?.length, `${action.id} без клавиш по умолчанию`);
  }
  assert.equal(
    Object.keys(DEFAULT_BINDINGS).length,
    ACTIONS.length,
    'список действий и раскладка по умолчанию обязаны совпадать'
  );
});
