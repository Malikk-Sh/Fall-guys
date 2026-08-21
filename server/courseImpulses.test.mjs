import test from 'node:test';
import assert from 'node:assert/strict';
import { applyObstacleImpulses } from '../shared/courseImpulses.js';
import { createPlayerSimulationState } from '../shared/playerSimulation.js';
import { PLAYER_FOOT, PLAYER_OBSTACLE_RADIUS } from '../shared/playerDimensions.js';

// Импульсы препятствий считаются без сцены — этого не хватало серверной симуляции, чтобы её
// расхождение с клиентом можно было честно измерить.
const at = (x, y, z, velocity = {}) =>
  createPlayerSimulationState({ position: { x, y, z }, velocity, grounded: true });

const options = (obstacles, extra = {}) => ({
  obstacles,
  now: 10,
  hitTimes: new Map(),
  playerRadius: PLAYER_OBSTACLE_RADIUS,
  footOffset: PLAYER_FOOT,
  knockback: 1,
  ...extra
});

const bumper = { id: 'b1', type: 'bumper', x: 0, y: 1, z: 0, radius: 1.2, color: 0xff4f91 };
const spring = { id: 's1', type: 'spring', x: 0, y: 0.6, z: 0, radius: 1.1 };
const puncher = {
  id: 'p1',
  type: 'puncher',
  x: 0,
  y: 1,
  z: 0,
  w: 3.15,
  d: 1.4,
  speed: 1,
  phase: 0,
  radius: 1.7
};

test('бампер выталкивает наружу и придаёт скорость от своего центра', () => {
  const state = at(0.4, 1, 0);
  const { events } = applyObstacleImpulses(state, options([bumper]));

  const distance = Math.hypot(state.position.x - bumper.x, state.position.z - bumper.z);
  assert.ok(
    Math.abs(distance - (bumper.radius + PLAYER_OBSTACLE_RADIUS)) < 1e-9,
    'игрок обязан оказаться ровно на границе удара'
  );
  assert.ok(state.velocity.x > 0, 'скорость направлена прочь от бампера');
  assert.equal(state.grounded, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'bumper');
  assert.equal(events[0].counted, true);
  assert.equal(events[0].knockdown, 0.4);
  assert.equal(events[0].color, bumper.color);
});

test('перезарядка удара не даёт бить дважды подряд', () => {
  const hitTimes = new Map();
  const first = applyObstacleImpulses(at(0.4, 1, 0), options([bumper], { hitTimes }));
  assert.equal(first.events.length, 1);

  const again = applyObstacleImpulses(at(0.4, 1, 0), options([bumper], { hitTimes, now: 10.1 }));
  assert.equal(again.events.length, 0, 'повторный удар в ту же перезарядку не засчитывается');

  const later = applyObstacleImpulses(at(0.4, 1, 0), options([bumper], { hitTimes, now: 11 }));
  assert.equal(later.events.length, 1, 'после перезарядки удар снова возможен');
});

test('сбитый игрок получает более длинную перезарядку, и она берётся из его состояния', () => {
  // 0.5 с после прошлого удара: обычная перезарядка (0.28) уже прошла, а перезарядка сбитого
  // игрока (1.5) — ещё нет.
  //
  // Выдержка выводится ИЗ СОСТОЯНИЯ, а не из аргумента. Аргументом она была, и стороны разошлись:
  // клиент передавал 1.5 лежащему игроку, серверная свободная траектория — всегда 0.
  const hitTimes = new Map([['b1', 9.5]]);

  const downed = at(0.4, 1, 0);
  downed.knockdownTimer = 1.2;
  assert.equal(applyObstacleImpulses(downed, options([bumper], { hitTimes })).events.length, 0);

  const upright = applyObstacleImpulses(at(0.4, 1, 0), options([bumper], { hitTimes }));
  assert.equal(upright.events.length, 1);
});

test('лежащего игрока повторный удар не двигает вообще, а не только не считает', () => {
  // Толчок меняет позицию и скорость ВНУТРИ `applyObstacleImpulses`, а `applyKnockdown` вызывается
  // уже после него — и его отказ повторно сбивать ничего не откатывает. Поэтому проверяется не
  // отсутствие события, а отсутствие физики: иначе серверная копия уезжала бы молча.
  const hitTimes = new Map([['b1', 9.5]]);
  const downed = at(0.4, 1, 0, { x: 1.5, y: -2, z: -0.5 });
  downed.knockdownTimer = 1.2;
  const before = { ...downed.position };
  const beforeVelocity = { ...downed.velocity };

  const { events } = applyObstacleImpulses(downed, options([bumper], { hitTimes }));

  assert.equal(events.length, 0);
  assert.deepEqual(downed.position, before, 'позиция лежащего не должна меняться повторным ударом');
  assert.deepEqual(downed.velocity, beforeVelocity, 'скорость лежащего не должна меняться');
  assert.equal(hitTimes.get('b1'), 9.5, 'время последнего удара не должно переписываться');
});

test('после подъёма удар снова разрешён', () => {
  const hitTimes = new Map([['b1', 9.5]]);
  const risen = at(0.4, 1, 0);
  risen.knockdownTimer = 0;
  assert.equal(applyObstacleImpulses(risen, options([bumper], { hitTimes })).events.length, 1);
});

test('пружина подбрасывает, но не считается попаданием и не сбивает', () => {
  const state = at(0, spring.y + 0.13 + PLAYER_FOOT, 0, { y: -3 });
  const { events } = applyObstacleImpulses(state, options([spring]));
  assert.equal(state.velocity.y, 11.4);
  assert.equal(state.grounded, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'spring');
  assert.equal(events[0].counted, undefined, 'трамплин не должен ломать цель «без попаданий»');
  assert.equal(events[0].knockdown, undefined);
});

test('пружина не срабатывает под тем, кто летит вверх', () => {
  const state = at(0, spring.y + 0.13 + PLAYER_FOOT, 0, { y: 5 });
  assert.equal(applyObstacleImpulses(state, options([spring])).events.length, 0);
});

test('множитель отдачи усиливает импульс, но не геометрию удара', () => {
  const normal = at(0.4, 1, 0);
  applyObstacleImpulses(normal, options([bumper]));
  const strong = at(0.4, 1, 0);
  applyObstacleImpulses(strong, options([bumper], { knockback: 2 }));

  assert.ok(Math.abs(strong.velocity.x - normal.velocity.x * 2) < 1e-9);
  assert.equal(strong.position.x, normal.position.x, 'выталкивание от множителя не зависит');
});

test('молот бьёт в сторону от своей оси и сбивает', () => {
  const state = at(1.2, 1, 0);
  const { events } = applyObstacleImpulses(state, options([puncher]));
  assert.ok(state.velocity.x > 0);
  assert.equal(state.grounded, false);
  assert.equal(events[0].name, 'puncher');
  assert.equal(events[0].knockdown, 0.55);
});

test('каждое событие помнит, где случился удар', () => {
  // За один шаг игрока может задеть два препятствия: точка всплеска обязана быть та, где ударило,
  // а не та, куда его вытолкнуло следующим.
  const far = { ...puncher, id: 'p2', x: 6 };
  const state = at(1.2, 1, 0);
  const { events } = applyObstacleImpulses(state, options([puncher, far]));
  assert.ok(events.length >= 1);
  for (const event of events) {
    assert.ok(Number.isFinite(event.at.x) && Number.isFinite(event.at.y) && Number.isFinite(event.at.z));
  }
});

test('далёкое препятствие не трогает ни состояние, ни события', () => {
  const state = at(40, 1, 40);
  const before = JSON.stringify(state);
  const { events } = applyObstacleImpulses(state, options([bumper, spring, puncher]));
  assert.equal(events.length, 0);
  assert.equal(JSON.stringify(state), before);
});
