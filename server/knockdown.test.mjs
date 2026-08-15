import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { KNOCKDOWN_IMMUNITY_TIME, Player } from '../client/game/Player.js';
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
    surfaceAt: () => ({ y: 0.5, delta: new THREE.Vector3() }),
    interact() {},
    checkpointFor: (_position, checkpoint) => checkpoint
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
  course.obstacles = [
    {
      type: 'bumper',
      mesh: {
        uuid: 'единственный-бампер',
        position: new THREE.Vector3(0, 0.9, 0),
        material: { color: { getHex: () => 0 } }
      },
      radius: 40
    }
  ];
  return course;
}

test('поднявшийся под иммунитетом не получает повторный удар от того же препятствия', () => {
  const scene = new THREE.Scene();
  const course = alwaysTouching();
  const player = new Player(scene, course, effects);
  player.teleport(new THREE.Vector3(0, 0.9, 0));

  // Препятствия трогает сам шаг физики (Player.step вызывает course.interact), поэтому здесь
  // достаточно шагать: одни часы на всё, ровно как в забеге.
  //
  // Отсчёт начинается не с нуля намеренно: отметка попадания сравнивается с нулём как с «никогда»,
  // поэтому в самый первый миг забега условие кулдауна не выполняется ни для кого.
  let clock = 1;
  const tick = () => {
    const at = clock;
    player.step(1 / 60, neutralInput, 0, at);
    clock += 1 / 60;
    return at;
  };

  const firstHitAt = tick();
  assert.equal(player.hits, 1, 'первый удар засчитан');
  assert.ok(player.knockdownTimer > 0, 'первый удар сбивает с ног');

  // Докуда защита обязана дотянуться: сколько лежать (длительность зависит от силы удара, поэтому
  // она измеряется, а не вписывается) плюс иммунитет после подъёма.
  const protectedUntil = firstHitAt + player.knockdownTimer + KNOCKDOWN_IMMUNITY_TIME;

  // Момент, когда та же балка ударила снова.
  let again = null;
  for (let step = 0; step < 400 && again === null; step++) {
    const at = tick();
    if (player.hits > 1) again = at;
  }

  // Защита не вечная: то же препятствие обязано снова заработать, иначе это была бы неуязвимость.
  assert.ok(again !== null, 'после защиты то же препятствие снова бьёт');
  // А вот и сам дефект: раньше окно в 1.5 с истекало прежде защиты, и в эту щель прилетал
  // полноценный удар — knockDown() отказывал по иммунитету, а импульс, эффекты и засчитанное
  // попадание применялись, и персонажа подбрасывало стоя.
  assert.ok(
    again >= protectedUntil,
    `повторный удар на ${again.toFixed(2)} с, а защита обязана держаться до ${protectedUntil.toFixed(2)} с`
  );
  player.dispose();
  course.dispose();
});

test('сбитого не задевает препятствие, которое его уже било, но задевает новое', () => {
  const scene = new THREE.Scene();
  const course = alwaysTouching();
  const player = new Player(scene, course, effects);
  player.teleport(new THREE.Vector3(0, 0.9, 0));
  player.step(1 / 60, neutralInput, 0, 1);
  assert.equal(player.hits, 1);
  assert.ok(player.knockdownTimer > 0, 'игрок сбит и защищён');

  // Второе препятствие рядом, игрока ещё не касавшееся. Защита отменяет ПОВТОРНЫЙ удар, а не физику
  // мира: незнакомая балка бьёт лежачего как раньше, иначе сбитый становился бы неуязвимым.
  course.obstacles.push({
    ...course.obstacles[0],
    mesh: { ...course.obstacles[0].mesh, uuid: 'другой-бампер' }
  });
  player.step(1 / 60, neutralInput, 0, 1 + 1 / 60);
  assert.equal(player.hits, 2, 'новое препятствие бьёт и сбитого');
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
