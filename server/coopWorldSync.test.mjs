import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCollapseEvent, requestCollapseUnderPlayer } from '../client/game/CoopWorldSync.js';

function fakeCourse() {
  return {
    tiles: [
      {
        id: 'tiles-0-0',
        delay: 0.8,
        respawn: 2.4,
        timer: 0,
        fallen: false,
        baseY: 0,
        platform: {
          w: 3,
          d: 3,
          disabled: false,
          mesh: { position: { x: 2, y: 0, z: -10 }, visible: true }
        }
      }
    ]
  };
}

test('локальный шаг на плитку отправляет ровно одно событие и запускает предупреждение сразу', () => {
  const course = fakeCourse();
  const sent = [];
  let cracks = 0;
  const id = requestCollapseUnderPlayer(
    course,
    { x: 2, y: 0.98, z: -10 },
    value => {
      sent.push(value);
      return true;
    },
    { crack: () => cracks++ }
  );

  assert.equal(id, 'tiles-0-0');
  assert.deepEqual(sent, ['tiles-0-0']);
  assert.equal(cracks, 1);
  assert.equal(course.tiles[0].timer, 0.8);
  assert.equal(course.tiles[0].collapseRequested, true);

  // Пока цикл уже идёт, стоящий на той же плитке не спамит сеть каждый физический шаг.
  assert.equal(
    requestCollapseUnderPlayer(course, { x: 2, y: 0.98, z: -10 }, value => sent.push(value)),
    null
  );
  assert.deepEqual(sent, ['tiles-0-0']);
});

test('серверная отметка компенсирует разную задержку доставки', () => {
  const fast = fakeCourse();
  const slow = fakeCourse();

  assert.equal(applyCollapseEvent(fast, { objectId: 'tiles-0-0', at: 10_000 }, 10_100), true);
  assert.equal(applyCollapseEvent(slow, { objectId: 'tiles-0-0', at: 10_000 }, 10_500), true);
  assert.ok(Math.abs(fast.tiles[0].timer - 0.7) < 1e-9);
  assert.ok(Math.abs(slow.tiles[0].timer - 0.3) < 1e-9);
  assert.equal(fast.tiles[0].fallen, false);
  assert.equal(slow.tiles[0].fallen, false);

  // При очень позднем получении клиент сразу попадает в уже упавшую фазу, а не начинает цикл заново.
  const late = fakeCourse();
  applyCollapseEvent(late, { objectId: 'tiles-0-0', at: 10_000 }, 11_000);
  assert.equal(late.tiles[0].fallen, true);
  assert.equal(late.tiles[0].platform.disabled, true);
  assert.equal(late.tiles[0].platform.mesh.visible, false);
  assert.ok(Math.abs(late.tiles[0].timer - 2.2) < 1e-9);
});

test('пакет старше полного цикла не обрушает уже восстановившуюся плитку задним числом', () => {
  const course = fakeCourse();
  course.tiles[0].fallen = true;
  course.tiles[0].platform.disabled = true;
  course.tiles[0].platform.mesh.visible = false;

  applyCollapseEvent(course, { objectId: 'tiles-0-0', at: 10_000 }, 13_500);
  assert.equal(course.tiles[0].fallen, false);
  assert.equal(course.tiles[0].timer, 0);
  assert.equal(course.tiles[0].platform.disabled, false);
  assert.equal(course.tiles[0].platform.mesh.visible, true);
});
