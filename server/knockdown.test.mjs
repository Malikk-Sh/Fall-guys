import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Player } from '../client/game/Player.js';
import { Course } from '../client/game/Course.js';
import { courseSpec } from '../client/core/Config.js';

const effects = { burst() {}, trail() {} };
const neutralInput = {
  movement: () => ({ x: 0, forward: 0, magnitude: 0 }),
  consume: () => false,
  isHeld: () => false
};

function flatCourse() {
  return {
    spec: { segmentCount: 99, finishZ: -999 },
    spawnFor: () => new THREE.Vector3(0, 0.884, 0),
    // Ровный пол с верхом на 0.5 — теми же плоскими опорами, что и у настоящей трассы.
    platforms: [
      { x: 0, y: 0, z: 0, w: 4000, h: 1, d: 4000, r: 0, type: 'box', disabled: false, delta: null }
    ],
    interact() {},
    checkpointFor: (_previous, _position, current) => current
  };
}

test('knockdown обмякает на 1–2 секунды, но не замораживает физику', () => {
  const scene = new THREE.Scene();
  const player = new Player(scene, flatCourse(), effects);
  player.teleport(new THREE.Vector3(0, 0.884, 0));
  player.velocity.set(8, 5, -2);
  assert.equal(player.knockDown(0.55), true);
  assert.equal(player.snapshot().state, 'knockdown');
  const firstTimer = player.knockdownTimer;
  assert.equal(player.knockDown(0.55), false, 'повторный контакт не продлевает текущее падение');
  assert.equal(player.knockdownTimer, firstTimer);

  const startX = player.position.x;
  for (let i = 0; i < 30; i++) player.step(1 / 60, neutralInput, 0, i / 60);
  assert.ok(player.position.x > startX + 0.5, 'импульс продолжает переносить лежащего игрока');
  assert.equal(player.snapshot().state, 'knockdown');

  for (let i = 30; i < 120; i++) player.step(1 / 60, neutralInput, 0, i / 60);
  assert.notEqual(player.snapshot().state, 'knockdown', 'через две секунды управление восстановлено');
  player.dispose();
});

test('coop downed остаётся отдельным состоянием от краткого knockdown', () => {
  const scene = new THREE.Scene();
  const player = new Player(scene, flatCourse(), effects);
  player.knockDown(0.5);
  player.goDown(new THREE.Vector3(0, 0.884, 0));
  assert.equal(player.snapshot().state, 'downed');
  assert.equal(player.knockdownTimer, 0);
  player.dispose();
});

// Одно препятствие, которое всегда достаёт до игрока. Настоящая балка сюда не нужна: проверяется
// не геометрия попадания, а то, кого Course.interact пускает во внутренность условия.
function alwaysTouching() {
  const course = new Course(new THREE.Scene(), courseSpec(3, 'easy'), { quality: 'low' });
  // Препятствие описано числами, а не мешем: физика удара читает саму запись, поэтому подделывать
  // сцену тут больше нечем и незачем.
  course.obstacles = [
    {
      id: 'единственный-бампер',
      type: 'bumper',
      mesh: { position: new THREE.Vector3(0, 0.9, 0) },
      x: 0,
      y: 0.9,
      z: 0,
      color: 0,
      radius: 40
    }
  ];
  return course;
}

test('иммунитет после подъёма запрещает новое сбивание, но не отменяет удар', () => {
  // Семантика окна выбрана осознанно, и это не то же самое, что «игнорировать попадание».
  //
  // Ревьюер предлагал во время иммунитета глушить и сам удар — иначе балка «бьёт неуязвимого».
  // В этой физике так не выходит: импульс, выталкивание и сбивание — одно неделимое событие, и
  // попытка оставить выталкивание без удара превращает бампер в стену (замер: четыре бот-теста
  // на прохождение падают). Поэтому иммунитет защищает ровно от того, ради чего он есть, — от
  // повторной потери управления на полторы секунды, — а мир продолжает толкать игрока как обычно.
  const scene = new THREE.Scene();
  const course = alwaysTouching();
  const player = new Player(scene, course, effects);
  player.teleport(new THREE.Vector3(0, 0.9, 0));

  // Первый удар сбивает. Время не ноль: отметка попадания сравнивается с нулём как с «никогда».
  let clock = 1;
  const tick = () => {
    player.step(1 / 60, neutralInput, 0, clock);
    clock += 1 / 60;
  };
  tick();
  assert.equal(player.hits, 1, 'первый удар засчитан');
  assert.ok(player.knockdownTimer > 0, 'первый удар сбивает с ног');

  // Досидели до подъёма: дальше идёт иммунитет.
  for (let step = 0; step < 400 && player.knockdownTimer > 0; step++) tick();
  assert.equal(player.knockdownTimer, 0, 'игрок поднялся');
  assert.ok(player.knockdownImmunityTimer > 0, 'иммунитет после подъёма идёт');

  // Удар во время иммунитета: попадание засчитывается и скорость меняется — мир работает…
  const hitsBefore = player.hits;
  for (let step = 0; step < 60 && player.hits === hitsBefore; step++) tick();
  assert.ok(player.hits > hitsBefore, 'препятствие продолжает бить и во время иммунитета');
  // …но второй раз с ног не сбивает: ради этого окно и существует.
  assert.equal(player.knockdownTimer, 0, 'иммунитет не даёт начать новое сбивание');
  player.dispose();
  course.dispose();
});

test('возрождение снимает позу сбивания, а не только его таймеры', () => {
  const scene = new THREE.Scene();
  const player = new Player(scene, flatCourse(), effects);
  player.knockDown(0.6);
  // Даём позе сложиться: она набирается затуханием, а не одним присваиванием.
  for (let step = 0; step < 30; step++) player.step(1 / 60, neutralInput, 0, step / 60);
  assert.ok(player.character.visual.rotation.x < -0.5, 'персонаж успел завалиться');

  player.respawn();
  assert.equal(player.character.visual.rotation.x, 0, 'наклон снят');
  assert.equal(player.character.visual.rotation.z, 0, 'крен снят');
  assert.equal(player.character.visual.position.y, 0, 'смещение вниз снято');
  player.dispose();
});
