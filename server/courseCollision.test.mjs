import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUPPORT_EDGE_TOLERANCE,
  SUPPORT_MAX_FOOT_RISE,
  SUPPORT_MAX_UPWARD_SPEED,
  supportIndexAt,
  supportTop
} from '../shared/courseCollision.js';

// Ступня игрока ниже его точки отсчёта ровно на эту величину — то же число, что в клиентском
// PlayerDimensions. Тест держит его локально: модуль коллизий сознательно принимает смещение
// снаружи и не должен зависеть от клиентских размеров.
const FOOT = 0.384;

const box = (overrides = {}) => ({
  x: 0,
  y: 0,
  z: 0,
  w: 4,
  h: 1,
  d: 4,
  r: 0,
  type: 'box',
  disabled: false,
  ...overrides
});

const standingOn = collider => supportTop(collider) + FOOT;

test('игрок, стоящий на плите, получает её верх как опору', () => {
  const colliders = [box()];
  const y = standingOn(colliders[0]);
  assert.equal(supportIndexAt(colliders, { x: 0, y, z: 0 }, y, 0, FOOT), 0);
  assert.equal(supportTop(colliders[0]), 0.5);
});

test('пустой или отсутствующий список опор не даёт опоры', () => {
  assert.equal(supportIndexAt([], { x: 0, y: 0.884, z: 0 }, 0.884, 0, FOOT), -1);
  assert.equal(supportIndexAt(null, { x: 0, y: 0.884, z: 0 }, 0.884, 0, FOOT), -1);
});

test('край опоры шире геометрии ровно на запас, а дальше пола нет', () => {
  const colliders = [box()];
  const y = standingOn(colliders[0]);
  const inside = colliders[0].w / 2 + SUPPORT_EDGE_TOLERANCE - 1e-6;
  const outside = colliders[0].w / 2 + SUPPORT_EDGE_TOLERANCE + 1e-6;
  assert.equal(supportIndexAt(colliders, { x: inside, y, z: 0 }, y, 0, FOOT), 0);
  assert.equal(supportIndexAt(colliders, { x: outside, y, z: 0 }, y, 0, FOOT), -1);
  assert.equal(supportIndexAt(colliders, { x: 0, y, z: outside }, y, 0, FOOT), -1);
});

test('цилиндр ограничен радиусом, а не описанным прямоугольником', () => {
  const colliders = [box({ type: 'cylinder', r: 2 })];
  const y = standingOn(colliders[0]);
  const corner = 2 / Math.SQRT2 + 0.2;
  assert.equal(supportIndexAt(colliders, { x: 0, y, z: 1.9 }, y, 0, FOOT), 0);
  assert.equal(
    supportIndexAt(colliders, { x: corner, y, z: corner }, y, 0, FOOT),
    -1,
    'угол описанного квадрата лежит вне цилиндра'
  );
});

test('свип ловит тонкую платформу, сквозь которую игрок проскочил за один шаг', () => {
  const colliders = [box({ h: 0.2 })];
  const top = supportTop(colliders[0]);
  // Ступня начала шаг заметно выше верха и закончила ниже него: пересечения на конец шага нет.
  const previousY = top + FOOT + 0.4;
  const y = top + FOOT - 0.25;
  assert.equal(supportIndexAt(colliders, { x: 0, y, z: 0 }, previousY, -12, FOOT), 0);
});

test('пролетающий снизу вверх не приземляется на платформу', () => {
  const colliders = [box()];
  const top = supportTop(colliders[0]);
  const y = top + FOOT;
  assert.equal(supportIndexAt(colliders, { x: 0, y, z: 0 }, y, SUPPORT_MAX_UPWARD_SPEED + 0.01, FOOT), -1);
  assert.equal(supportIndexAt(colliders, { x: 0, y, z: 0 }, y, SUPPORT_MAX_UPWARD_SPEED, FOOT), 0);
});

test('ступня, начавшая шаг ниже опоры, не втягивается наверх', () => {
  const colliders = [box()];
  const top = supportTop(colliders[0]);
  const y = top + FOOT;
  const deepPreviousY = top - FOOT - 0.01 + FOOT;
  assert.equal(supportIndexAt(colliders, { x: 0, y, z: 0 }, deepPreviousY, 0, FOOT), -1);
});

test('опора выше допустимого подъёма ступни не подхватывается', () => {
  const colliders = [box()];
  const top = supportTop(colliders[0]);
  const high = top + SUPPORT_MAX_FOOT_RISE + FOOT + 0.01;
  assert.equal(supportIndexAt(colliders, { x: 0, y: high, z: 0 }, high, 0, FOOT), -1);
});

test('из нескольких пересекающихся опор выбирается самая высокая', () => {
  const colliders = [box({ y: 0 }), box({ y: 0.6 }), box({ y: 0.3 })];
  const y = standingOn(colliders[1]);
  assert.equal(supportIndexAt(colliders, { x: 0, y, z: 0 }, y, 0, FOOT), 1);
});

test('выключенная опора не подхватывается там, где включённая подхватилась бы', () => {
  const enabled = [box({ y: 0.6 })];
  const y = standingOn(enabled[0]);
  assert.equal(supportIndexAt(enabled, { x: 0, y, z: 0 }, y, 0, FOOT), 0);
  const disabled = [box({ y: 0.6, disabled: true })];
  assert.equal(supportIndexAt(disabled, { x: 0, y, z: 0 }, y, 0, FOOT), -1);
});

test('нечисловая вертикальная скорость не выдаёт опору', () => {
  const colliders = [box()];
  const y = standingOn(colliders[0]);
  assert.equal(supportIndexAt(colliders, { x: 0, y, z: 0 }, y, Number.NaN, FOOT), -1);
});
