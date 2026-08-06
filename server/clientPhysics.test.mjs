import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { courseSpec } from '../client/core/Config.js';
import { Course } from '../client/game/Course.js';
import { Effects } from '../client/game/Effects.js';
import { Player } from '../client/game/Player.js';
import { CameraController } from '../client/game/CameraController.js';

const idleInput = () => ({ movement: () => ({ x: 0, forward: 0, magnitude: 0 }), consume: () => false });

const FIXED_DT = 1 / 60;

// Прогон физики фиксированным шагом — ровно так, как это делает Game.loop.
function simulate(player, course, input, steps, startElapsed = 0) {
  for (let i = 0; i < steps; i++) {
    const elapsed = startElapsed + i * FIXED_DT;
    course.update(FIXED_DT, elapsed);
    player.step(FIXED_DT, input, 0, elapsed);
  }
}

test('procedural course is deterministic for a shared seed', () => {
  const a = new Course(new THREE.Scene(), courseSpec(123456, 'normal'), { quality: 'low' }),
    b = new Course(new THREE.Scene(), courseSpec(123456, 'normal'), { quality: 'low' });
  assert.deepEqual(a.stageNames, b.stageNames);
  assert.equal(a.spec.checkpoints.length, 6);
  assert.equal(a.stageNames.at(-1), 'ВОРОТА ПОБЕДЫ');
  a.dispose();
  b.dispose();
});

test('player settles on a platform, runs camera-relative, and jumps with buffering', () => {
  const scene = new THREE.Scene(),
    effects = new Effects(scene, 'low'),
    course = new Course(scene, courseSpec(99, 'easy'), { quality: 'low' }),
    player = new Player(scene, course, effects);

  simulate(player, course, idleInput(), 40);
  assert.equal(player.grounded, true);

  const startZ = player.position.z;
  const forward = { movement: () => ({ x: 0, forward: 1, magnitude: 1 }), consume: () => false };
  simulate(player, course, forward, 35, 0.7);
  assert.ok(player.position.z < startZ - 1.5);

  let jump = true;
  const jumping = {
    movement: () => ({ x: 0, forward: 0, magnitude: 0 }),
    consume: action => (action === 'jump' && jump ? ((jump = false), true) : false)
  };
  player.step(FIXED_DT, jumping, 0, 1.4);
  assert.ok(player.velocity.y > 7);
  const airborne = player.snapshot();
  assert.ok(airborne.vy > 7);
  assert.equal(airborne.state, 'air');
  assert.equal(player.startSlam(), true);
  assert.equal(player.snapshot().state, 'slam');

  player.dispose();
  course.dispose();
});

test('фиксированный шаг даёт одинаковую высоту прыжка при любой частоте кадров', () => {
  // Главная причина, ради которой введён фиксированный шаг. Раньше в физику подавалась дельта
  // кадра, и высота прыжка на мониторе 144 Гц отличалась от высоты на 60 Гц — игра буквально
  // вела себя по-разному на разном железе.
  //
  // Здесь мы имитируем три частоты кадров, раскладывая одно и то же время на разное число
  // кадров, и проверяем, что физика прошла одинаковое число одинаковых шагов.
  const jumpHeightAt = frameRate => {
    const scene = new THREE.Scene();
    const effects = new Effects(scene, 'low');
    const course = new Course(scene, courseSpec(2024, 'easy'), { quality: 'low' });
    const player = new Player(scene, course, effects);

    simulate(player, course, idleInput(), 40);

    let jump = true;
    const jumping = {
      movement: () => ({ x: 0, forward: 0, magnitude: 0 }),
      consume: action => (action === 'jump' && jump ? ((jump = false), true) : false)
    };

    // Аккумулятор фиксированного шага, как в Game.loop.
    const frameDt = 1 / frameRate;
    let accumulator = 0;
    let peak = -Infinity;
    let elapsed = 1;
    for (let frame = 0; frame < Math.ceil(frameRate * 0.8); frame++) {
      accumulator += frameDt;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < 5) {
        course.update(FIXED_DT, elapsed);
        player.step(FIXED_DT, jump ? jumping : idleInput(), 0, elapsed);
        accumulator -= FIXED_DT;
        elapsed += FIXED_DT;
        steps++;
        peak = Math.max(peak, player.position.y);
      }
    }

    player.dispose();
    course.dispose();
    return peak;
  };

  const at30 = jumpHeightAt(30);
  const at60 = jumpHeightAt(60);
  const at144 = jumpHeightAt(144);

  // Расхождение допустимо только в пределах одного шага физики: аккумулятор может не успеть
  // отдать последний шаг до конца отрезка. Но сама траектория обязана совпадать.
  assert.ok(Math.abs(at60 - at144) < 0.05, `60 Гц: ${at60}, 144 Гц: ${at144}`);
  assert.ok(Math.abs(at30 - at60) < 0.05, `30 Гц: ${at30}, 60 Гц: ${at60}`);
  assert.ok(at60 > 1.5, 'прыжок должен реально поднимать персонажа');
});

test('отрисовка интерполирует между шагами физики, не меняя саму физику', () => {
  const scene = new THREE.Scene();
  const effects = new Effects(scene, 'low');
  const course = new Course(scene, courseSpec(5, 'easy'), { quality: 'low' });
  const player = new Player(scene, course, effects);

  simulate(player, course, idleInput(), 30);
  const forward = { movement: () => ({ x: 0, forward: 1, magnitude: 1 }), consume: () => false };
  simulate(player, course, forward, 20, 0.5);

  const before = player.previous.clone();
  const after = player.physics.clone();
  assert.ok(before.distanceTo(after) > 0, 'за шаг игрок должен сдвинуться');

  // alpha=0 — состояние до шага, alpha=1 — после, alpha=0.5 — ровно посередине.
  player.render(0);
  assert.ok(player.visualPosition.distanceTo(before) < 1e-9);
  player.render(1);
  assert.ok(player.visualPosition.distanceTo(after) < 1e-9);
  player.render(0.5);
  const middle = before.clone().lerp(after, 0.5);
  assert.ok(player.visualPosition.distanceTo(middle) < 1e-9);

  // Отрисовка не должна трогать физическую позицию.
  assert.ok(player.physics.distanceTo(after) < 1e-9);

  player.dispose();
  course.dispose();
});

test('телепорт не оставляет следа интерполяции', () => {
  const scene = new THREE.Scene();
  const effects = new Effects(scene, 'low');
  const course = new Course(scene, courseSpec(11, 'easy'), { quality: 'low' });
  const player = new Player(scene, course, effects);

  simulate(player, course, idleInput(), 20);
  const target = new THREE.Vector3(0, 40, -100);
  player.teleport(target);

  // Даже при alpha=0 персонаж обязан быть уже в новой точке: иначе кадр отрисовки показал бы
  // его летящим через полкарты.
  player.render(0);
  assert.ok(player.visualPosition.distanceTo(target) < 1e-9);
  player.render(0.5);
  assert.ok(player.visualPosition.distanceTo(target) < 1e-9);

  player.dispose();
  course.dispose();
});

test('материалы трассы переиспользуются, а не создаются на каждый объект', () => {
  const scene = new THREE.Scene();
  const course = new Course(scene, courseSpec(321, 'chaos'), { quality: 'low' });

  let meshCount = 0;
  course.group.traverse(object => {
    if (object.isMesh) meshCount++;
  });

  assert.ok(meshCount > 100, `ожидалось много мешей, получено ${meshCount}`);
  // Уникальных сочетаний цвета и свойств заведомо меньше полусотни. Раньше материал создавался
  // на каждый вызов box() — то есть их было столько же, сколько мешей.
  assert.ok(
    course.materials.size < 50,
    `материалов ${course.materials.size} при ${meshCount} мешах — кэш не работает`
  );

  course.dispose();
  assert.equal(course.materials.size, 0, 'dispose должен освобождать кэш материалов');
});

test('camera orbit and recenter math stays finite without a renderer', () => {
  const scene = new THREE.Scene(),
    effects = new Effects(scene, 'low'),
    course = new Course(scene, courseSpec(7, 'easy'), { quality: 'low' }),
    player = new Player(scene, course, effects),
    camera = new THREE.PerspectiveCamera(),
    controller = new CameraController(camera);
  const input = { consumeCamera: () => ({ x: 42, y: -18 }), consume: () => false };
  controller.update(0.016, player, input, course);
  assert.ok(camera.position.toArray().every(Number.isFinite));
  assert.ok(Number.isFinite(controller.yaw));
  player.dispose();
  course.dispose();
});

test('кооп-кадрирование камеры удерживает обоих игроков и остаётся конечным', () => {
  const scene = new THREE.Scene();
  const effects = new Effects(scene, 'low');
  const course = new Course(scene, courseSpec(7, 'easy'), { quality: 'low' });
  const player = new Player(scene, course, effects);
  const camera = new THREE.PerspectiveCamera();
  const controller = new CameraController(camera);
  const input = { consumeCamera: () => ({ x: 0, y: 0 }), consume: () => false };

  // Без напарника — обычное слежение.
  controller.update(0.016, player, input, course, null);
  const soloDistance = camera.position.distanceTo(controller.target);

  // С напарником рядом камера обязана отъехать, чтобы вместить обоих.
  const partner = player.visualPosition.clone().add(new THREE.Vector3(6, 0, -6));
  for (let i = 0; i < 60; i++) controller.update(0.016, player, input, course, partner);
  const coopDistance = camera.position.distanceTo(controller.target);

  assert.ok(camera.position.toArray().every(Number.isFinite));
  assert.ok(
    coopDistance > soloDistance,
    `в коопе камера должна отъезжать: ${coopDistance} ≤ ${soloDistance}`
  );

  player.dispose();
  course.dispose();
});

// Модификаторы дня проверяются здесь, а не только по таблице настроек: между «правило описано» и
// «правило действует» помещается вся физика, и разойтись им ничто не мешает.
//
// Каждая проверка сравнивает два прогона — обычный и изменённый — на одной трассе и с одним вводом.
// Абсолютные числа тут были бы привязкой к текущему балансу; сравнение переживёт его правку.
test('модификаторы дня действительно меняют физику, а не только описание', () => {
  const holdJump = {
    movement: () => ({ x: 0, forward: 0, magnitude: 0 }),
    consume: () => false,
    isHeld: action => action === 'jump'
  };

  // Планирование: удержание прыжка в падении замедляет снижение. С «БЕЗ КРЫЛЬЕВ» — не должно.
  const fallHeight = modifier => {
    const scene = new THREE.Scene(),
      effects = new Effects(scene, 'low'),
      course = new Course(scene, courseSpec(99, 'easy'), { quality: 'low' }),
      player = new Player(scene, course, effects, { modifier });
    // Роняем с высоты, чтобы падение шло без опоры под ногами.
    player.teleport(new THREE.Vector3(40, 30, -6));
    simulate(player, course, holdJump, 60);
    const y = player.position.y;
    player.dispose();
    course.dispose();
    return y;
  };

  const glided = fallHeight(null);
  const dropped = fallHeight({ id: 'no-wings', glide: false });
  assert.ok(dropped < glided, `без планирования падение обязано быть быстрее: ${dropped} ≥ ${glided}`);

  const moon = fallHeight({ id: 'moon-walk', gravity: 0.72 });
  assert.ok(moon > glided, `при слабой гравитации падение медленнее: ${moon} ≤ ${glided}`);

  // Рывок: сильнее — значит дальше за то же время. Заодно считается счётчик рывков для цели «БЕЗ РЫВКА».
  const dashDistance = modifier => {
    const scene = new THREE.Scene(),
      effects = new Effects(scene, 'low'),
      course = new Course(scene, courseSpec(99, 'easy'), { quality: 'low' }),
      player = new Player(scene, course, effects, { modifier });
    simulate(player, course, idleInput(), 30);
    const from = player.position.z;
    let fired = false;
    const dash = {
      movement: () => ({ x: 0, forward: 1, magnitude: 1 }),
      consume: action => (action === 'dive' && !fired ? ((fired = true), true) : false)
    };
    simulate(player, course, dash, 20, 0.5);
    const travelled = from - player.position.z;
    const dashes = player.dashes;
    player.dispose();
    course.dispose();
    return { travelled, dashes };
  };

  const normalDash = dashDistance(null);
  const turboDash = dashDistance({ id: 'turbo-dash', dash: 1.4, dashCooldown: 0.5 });
  assert.equal(normalDash.dashes, 1, 'рывок обязан считаться — на нём держится цель «БЕЗ РЫВКА»');
  assert.ok(
    turboDash.travelled > normalDash.travelled,
    `усиленный рывок обязан уносить дальше: ${turboDash.travelled} ≤ ${normalDash.travelled}`
  );
});

// Направление входит множителем в ту же скорость, что и темп, поэтому разворачивается всё, что от
// неё зависит: вертушки, молоты и подвижные платформы.
//
// Проверяется точное свойство, а не «стало иначе»: обратный ход — это тот же мир, проигранный
// назад, то есть состояние в момент +T обычной трассы совпадает с состоянием в момент −T обратной.
//
// Зеркальности по значению («молот там же, но с другим знаком») здесь нет и быть не может: у
// каждого препятствия своя фаза, и sin(−t·s + φ) не равен −sin(t·s + φ). Первая версия теста
// требовала именно этого и падала — на неверном ожидании, а не на коде.
test('обратный ход проигрывает движение препятствий назад', () => {
  const sampleAt = (modifier, elapsed) => {
    const scene = new THREE.Scene(),
      course = new Course(scene, { ...courseSpec(2024, 'chaos'), modifier }, { quality: 'low' });
    course.update(1 / 60, elapsed);
    const spinner = course.obstacles.find(o => o.type === 'spinner');
    const puncher = course.obstacles.find(o => o.type === 'puncher');
    const moving = course.dynamic.find(platform => platform.motion);
    const sample = {
      spinner: spinner ? spinner.angle : null,
      puncher: puncher ? puncher.mesh.position.x : null,
      platform: moving ? moving.mesh.position[moving.motion.axis] : null
    };
    course.dispose();
    return sample;
  };

  const T = 1.4;
  const forward = sampleAt(null, T);
  const reverse = sampleAt({ id: 'reverse', obstacleDirection: -1 }, -T);
  const alsoForward = sampleAt({ id: 'reverse', obstacleDirection: -1 }, T);

  const moved = Object.entries(forward).filter(([, value]) => value !== null);
  assert.ok(moved.length > 0, 'подготовка: на трассе должно быть хоть одно подвижное препятствие');

  for (const [what, value] of moved) {
    assert.ok(
      Math.abs(reverse[what] - value) < 1e-9,
      `${what}: обратный ход в −T обязан совпасть с обычным в +T (${reverse[what]} против ${value})`
    );
    // И при этом в тот же момент времени положение обязано отличаться — иначе «обратный ход»
    // ничего не менял бы, а тест выше проходил бы и на пустой правке.
    assert.notEqual(alsoForward[what], value, `${what}: в тот же момент ход обязан отличаться`);
  }
});
