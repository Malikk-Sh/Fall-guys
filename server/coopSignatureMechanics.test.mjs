import test from 'node:test';
import assert from 'node:assert/strict';
import { AsymmetricSignalPuzzle, EnergyCore, resolveTether } from '../client/game/CoopSignatureMechanics.js';

const actor = (id, x, y, z) => ({
  id,
  position: { x, y, z },
  velocity: { x: 0, y: 0, z: 0 }
});

test('энергоядро можно поднять, бросить напарнику и вставить в приёмник', () => {
  const first = actor('a', 0, 1, 0);
  const partner = actor('b', 8, 1, 0);
  const core = new EnergyCore({ x: 0, y: 1, z: 0 }, [{ id: 'socket', x: 12, y: 1, z: 0 }]);
  assert.equal(core.pickup(first), true);
  first.position.x = 4;
  assert.equal(core.update([first, partner], 1 / 60).position.x, 4);
  assert.equal(core.throw(first, { x: 1, y: 0.4, z: 0 }), true);
  for (let frame = 0; frame < 30; frame++) core.update([first, partner], 1 / 60);
  partner.position = { ...core.position };
  assert.equal(core.pickup(partner), true, 'напарник ловит то же ядро');
  partner.position = { x: 12, y: 0, z: 0 };
  core.update([first, partner], 1 / 60);
  assert.equal(core.throw(partner, { x: 0, y: 0, z: 0 }), true);
  for (let frame = 0; frame < 20 && !core.insertedInto; frame++) core.update([first, partner], 1 / 60);
  assert.equal(core.insertedInto, 'socket');
  assert.deepEqual(core.state().poweredSockets, ['socket']);
});

test('трос ограничивает расстояние и страхует нижнего игрока', () => {
  const local = actor('a', 0, -5, 0);
  const partner = actor('b', 0, 1, 12);
  local.velocity.y = -12;
  const before = Math.hypot(12, 6);
  const result = resolveTether(local, partner, 1 / 60, { maxLength: 10, catchDepth: 2 });
  const after = Math.hypot(
    local.position.x - partner.position.x,
    local.position.y - partner.position.y,
    local.position.z - partner.position.z
  );
  assert.equal(result.taut, true);
  assert.ok(after < before, 'натянутый трос подтягивает к напарнику');
  assert.ok(local.velocity.y > -5, 'падение заметно гасится');
  assert.ok(result.correction <= 0.18, 'один кадр не телепортирует игрока');
});

test('асимметричный пульт разделяет подсказку и кнопки между игроками', () => {
  const puzzle = new AsymmetricSignalPuzzle('ch9-console');
  const ids = ['operator', 'guide'];
  const roles = puzzle.roles(ids);
  const guide = puzzle.view(roles.guide, ids);
  const operator = puzzle.view(roles.operator, ids);
  assert.equal(guide.role, 'guide');
  assert.ok(guide.sequence.length >= 3);
  assert.deepEqual(guide.controls, []);
  assert.equal(operator.role, 'operator');
  assert.deepEqual(operator.sequence, []);
  for (let index = 0; index < puzzle.sequence.length; index++) {
    const solved = puzzle.press(roles.operator, puzzle.sequence[index], ids);
    assert.equal(solved, index === puzzle.sequence.length - 1);
  }
});

test('последовательность символов детерминирована идентификатором задачи', () => {
  assert.deepEqual(new AsymmetricSignalPuzzle('same').sequence, new AsymmetricSignalPuzzle('same').sequence);
  assert.notDeepEqual(
    new AsymmetricSignalPuzzle('same').sequence,
    new AsymmetricSignalPuzzle('different').sequence
  );
});
