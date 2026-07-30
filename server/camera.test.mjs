// Тесты двух режимов камеры.
//
// Проверять камеру глазами дорого и ненадёжно, а ломается в ней ровно одна вещь: автодоворот.
// Он должен работать в режиме слежения и молчать в свободном — иначе «свободная» камера через
// секунду бега снова смотрит в спину, и весь режим бессмысленен. Это и проверяется, синтетическим
// временем и без браузера.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CameraController, CAMERA_MODES } from '../client/game/CameraController.js';

// Подставная реализация localStorage: в Node его нет, а сохранение режима проверить надо.
const fakeStorage = () => {
  const data = new Map();
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    data
  };
};

const withStorage = (storage, fn) => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (had) globalThis.localStorage = previous;
    else delete globalThis.localStorage;
  }
};

// Игрок бежит вперёд, но повёрнут в сторону: разница между поворотом персонажа и yaw камеры —
// это ровно то, что съедает автодоворот.
const makePlayer = (rotationY = 1.2) => ({
  visualPosition: new THREE.Vector3(0, 1, 0),
  velocity: { x: 0, y: 0, z: -6 },
  character: { group: { rotation: { y: rotationY } } }
});

const makeInput = (pressed = {}) => ({
  consumeCamera: () => ({ x: 0, y: 0 }),
  consume: action => {
    const value = !!pressed[action];
    pressed[action] = false;
    return value;
  }
});

const course = { cameraMeshes: [] };

// Прогоняет секунду обновлений шагами по 1/60 — примерно столько живёт автодоворот.
const run = (controller, player, input, seconds = 1) => {
  for (let i = 0; i < Math.round(seconds * 60); i++)
    controller.update(1 / 60, player, input, course, null);
};

test('по умолчанию камера в режиме слежения', () => {
  withStorage(fakeStorage(), () => {
    const controller = new CameraController(new THREE.PerspectiveCamera());
    assert.equal(controller.mode, 'follow');
  });
});

test('переключение режима сохраняется и переживает пересоздание', () => {
  const storage = fakeStorage();
  withStorage(storage, () => {
    const first = new CameraController(new THREE.PerspectiveCamera());
    assert.equal(first.toggleMode(), 'free');
    assert.equal(storage.getItem('wobble-camera-mode'), 'free');
    // Новый контроллер — как после перезагрузки страницы.
    assert.equal(new CameraController(new THREE.PerspectiveCamera()).mode, 'free');
    assert.equal(first.toggleMode(), 'follow');
    assert.equal(new CameraController(new THREE.PerspectiveCamera()).mode, 'follow');
  });
});

test('мусор в хранилище не ломает камеру', () => {
  const storage = fakeStorage();
  storage.setItem('wobble-camera-mode', 'cinematic');
  withStorage(storage, () => {
    assert.equal(new CameraController(new THREE.PerspectiveCamera()).mode, 'follow');
  });
  assert.ok(CAMERA_MODES.includes('follow') && CAMERA_MODES.includes('free'));
});

test('в режиме слежения камера сама доворачивается за спину', () => {
  withStorage(fakeStorage(), () => {
    const controller = new CameraController(new THREE.PerspectiveCamera());
    controller.yaw = 0;
    const player = makePlayer(1.2);
    run(controller, player, makeInput());
    assert.ok(
      Math.abs(controller.yaw - 1.2) < 0.35,
      `за секунду бега камера должна почти догнать поворот персонажа, а yaw = ${controller.yaw}`
    );
  });
});

test('в свободном режиме камера держит направление', () => {
  withStorage(fakeStorage(), () => {
    const controller = new CameraController(new THREE.PerspectiveCamera());
    controller.toggleMode();
    controller.yaw = 0;
    const player = makePlayer(1.2);
    run(controller, player, makeInput(), 3);
    assert.equal(controller.yaw, 0, 'свободная камера не должна поворачиваться сама');
  });
});

test('взгляд за спину работает в свободном режиме и не меняет его', () => {
  withStorage(fakeStorage(), () => {
    const controller = new CameraController(new THREE.PerspectiveCamera());
    controller.toggleMode();
    controller.yaw = 0;
    const player = makePlayer(1.2);
    controller.update(1 / 60, player, makeInput({ recenter: true }), course, null);
    assert.equal(controller.yaw, 1.2, 'разовый доворот по кнопке должен сработать');
    assert.equal(controller.mode, 'free', 'кнопка «за спину» не переключает режим');
  });
});

test('ручной поворот на время отключает автодоворот', () => {
  withStorage(fakeStorage(), () => {
    const controller = new CameraController(new THREE.PerspectiveCamera());
    controller.yaw = 0;
    const player = makePlayer(1.2);
    let swiped = false;
    const input = {
      consumeCamera: () => (swiped ? { x: 0, y: 0 } : ((swiped = true), { x: 40, y: 0 })),
      consume: () => false
    };
    controller.update(1 / 60, player, input, course, null);
    const afterSwipe = controller.yaw;
    // Полсекунды спустя автодоворот ещё не должен ожить: пауза после свайпа — 2.25 с.
    for (let i = 0; i < 30; i++) controller.update(1 / 60, player, input, course, null);
    assert.equal(controller.yaw, afterSwipe, 'камера не должна вырываться из рук сразу после свайпа');
  });
});

test('переключение режима кнопкой меняет режим ровно один раз', () => {
  withStorage(fakeStorage(), () => {
    const controller = new CameraController(new THREE.PerspectiveCamera());
    const player = makePlayer(0);
    const pressed = { cameraMode: true };
    controller.update(1 / 60, player, makeInput(pressed), course, null);
    assert.equal(controller.mode, 'free');
    // Кнопка уже съедена — следующий кадр режим не трогает.
    controller.update(1 / 60, player, makeInput(pressed), course, null);
    assert.equal(controller.mode, 'free');
  });
});
