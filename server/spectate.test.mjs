// Выбор соперника для досмотра.
//
// Своим финишем гонка не кончается, и после него камера должна на кого-то смотреть. Правило выбора
// проверяется здесь отдельно от сцены и сети: это единственная часть досмотра, которую можно
// проверить без браузера, и единственная, где есть что перепутать.

import test from 'node:test';
import assert from 'node:assert/strict';
import { racersStillRunning, spectateTarget } from '../client/core/spectate.js';

// Ось Z направлена от старта к финишу отрицательно: меньше — дальше по трассе.
const racer = (id, checkpoint, z) => ({ id, checkpoint, z });

test('смотреть не на кого — и это не ошибка', () => {
  assert.equal(spectateTarget([], null), null);
  assert.equal(spectateTarget(undefined, 'bot:0'), null);
});

test('первым в кадр попадает тот, кто ближе к финишу', () => {
  const racers = [racer('a', 1, -10), racer('b', 3, -50), racer('c', 2, -30)];
  assert.equal(spectateTarget(racers, null), 'b');
});

test('при равном числе точек ближе тот, кто дальше по трассе', () => {
  assert.equal(spectateTarget([racer('a', 2, -20), racer('b', 2, -44)], null), 'b');
});

test('выбранный соперник не меняется, пока он бежит', () => {
  // Главное свойство. Двое идут почти вровень и меняются местами по нескольку раз в секунду;
  // камера, каждый кадр честно выбирающая лидера, прыгала бы между ними — смотреть невозможно.
  const first = [racer('a', 2, -30), racer('b', 2, -31)];
  const target = spectateTarget(first, null);
  assert.equal(target, 'b');
  const overtaken = [racer('a', 2, -34), racer('b', 2, -33)];
  assert.equal(spectateTarget(overtaken, target), 'b', 'обгон не должен дёргать камеру');
});

test('когда прежний соперник сошёл с трассы, ищется новый', () => {
  const target = spectateTarget([racer('a', 1, -8), racer('b', 3, -40)], null);
  assert.equal(target, 'b');
  // Дошёл, вышел или потерял связь — для выбора это одно и то же: его больше нет в списке.
  assert.equal(spectateTarget([racer('a', 1, -8)], target), 'a');
});

test('бегущими считаются все, кроме себя и уже дошедших', () => {
  const remotes = new Map([
    ['me', { checkpoint: 6, position: { z: -100 } }],
    ['done', { checkpoint: 6, position: { z: -100 } }],
    ['running', { checkpoint: 2, position: { z: -30 } }]
  ]);
  const board = [{ id: 'done' }, { id: 'me' }];
  const racers = racersStillRunning(remotes, board, 'me');
  assert.deepEqual(
    racers.map(item => item.id),
    ['running']
  );
});

test('отсутствующая доска не превращает всех в дошедших', () => {
  // Доска приходит вместе с сообщением о финише. Первый же кадр досмотра может опередить её.
  const remotes = new Map([['other', { checkpoint: 1, position: { z: -12 } }]]);
  assert.deepEqual(
    racersStillRunning(remotes, undefined, 'me').map(item => item.id),
    ['other']
  );
});

test('участник без известного положения не ломает выбор', () => {
  // Модель соперника создаётся раньше, чем до неё доедет первый снапшот.
  const remotes = new Map([['fresh', { checkpoint: 0, position: null }]]);
  const racers = racersStillRunning(remotes, [], 'me');
  assert.equal(racers[0].z, 0);
  assert.equal(spectateTarget(racers, null), 'fresh');
});
