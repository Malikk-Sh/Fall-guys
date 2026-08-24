// Клиентская половина того же замыкания.
//
// Сервер теперь отвечает на отказ в финише двумя разными способами: «добеги до ленты» и «арка не
// пройдена». Второй ответ бесполезен, если клиент продолжает считать арку пройденной: счётчик
// чекпоинтов держит и условие финиша, и точку возрождения, и игрок падал бы обратно ЗА арку,
// которую ему надо пересечь.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { bindNetwork } from '../client/net/networkBindings.js';
import { courseSpec } from '../client/core/Config.js';
import { Course } from '../client/game/Course.js';
import { Effects } from '../client/game/Effects.js';
import { Player } from '../client/game/Player.js';

function fakeGame({ matchId = 'm1' } = {}) {
  const handlers = new Map();
  const calls = { toasts: [], respawns: [], rollbacks: [], retryAllowed: 0, reopened: 0 };
  const game = {
    running: false,
    input: { enabled: false },
    net: {
      id: 'me',
      matchId,
      on: (type, handler) => handlers.set(type, handler),
      allowFinishRetry: () => calls.retryAllowed++
    },
    session: { reopenFinish: () => calls.reopened++ },
    ui: { toast: text => calls.toasts.push(text) },
    player: {
      finished: true,
      checkpoint: 6,
      rollbackCheckpoint(value) {
        calls.rollbacks.push(value);
        this.checkpoint = Math.min(this.checkpoint, value);
        return true;
      },
      respawn(position) {
        calls.respawns.push({ x: position.x, y: position.y, z: position.z });
      }
    }
  };
  bindNetwork(game);
  return { game, handlers, calls };
}

test('отказ «арка не пройдена» откатывает счётчик чекпоинтов клиента', () => {
  const { game, handlers, calls } = fakeGame();
  handlers.get('finishRejected')({
    matchId: 'm1',
    reason: 'checkpoint-missing',
    checkpoint: 5,
    position: { x: 0, y: 1.15, z: -50 }
  });

  assert.deepEqual(calls.rollbacks, [5]);
  assert.equal(game.player.checkpoint, 5);
  assert.equal(game.player.finished, false);
  assert.equal(game.input.enabled, true);
  assert.deepEqual(calls.respawns, [{ x: 0, y: 1.15, z: -50 }]);
  assert.deepEqual(calls.toasts, ['Последний чекпоинт не засчитан — пройдите через арку.']);
});

test('обычный отказ счётчик не трогает', () => {
  const { game, handlers, calls } = fakeGame();
  handlers.get('finishRejected')({
    matchId: 'm1',
    reason: 'finish-validation',
    checkpoint: 6,
    position: { x: 0, y: 1.1, z: -104 }
  });

  assert.deepEqual(calls.rollbacks, []);
  assert.equal(game.player.checkpoint, 6);
  assert.deepEqual(calls.toasts, ['Финиш не засчитан — добегите до ленты ещё раз.']);
});

test('отказ из чужого забега игрока не двигает', () => {
  const { game, handlers, calls } = fakeGame({ matchId: 'm2' });
  handlers.get('finishRejected')({
    matchId: 'm1',
    reason: 'checkpoint-missing',
    checkpoint: 5,
    position: { x: 0, y: 1.15, z: -50 }
  });

  assert.deepEqual(calls.respawns, []);
  assert.deepEqual(calls.rollbacks, []);
  assert.equal(calls.retryAllowed, 0);
  assert.equal(game.player.finished, true, 'чужой отказ не должен возвращать игрока в забег');
});

test('Player.rollbackCheckpoint двигает и счётчик, и точку возрождения', () => {
  const scene = new THREE.Scene(),
    effects = new Effects(scene, 'low'),
    spec = courseSpec(777, 'normal'),
    course = new Course(scene, spec, { quality: 'low' }),
    player = new Player(scene, course, effects);

  const last = spec.checkpoints.length;
  player.checkpoint = last;
  player.spawn.copy(course.spawnFor(last));

  assert.equal(player.rollbackCheckpoint(last - 1), true);
  assert.equal(player.checkpoint, last - 1);
  assert.deepEqual(
    { x: player.spawn.x, y: player.spawn.y, z: player.spawn.z },
    { ...course.spawnFor(last - 1) }
  );
  // Точка возрождения обязана оказаться ПЕРЕД непройденной аркой: прогресс идёт в минус по Z.
  assert.ok(player.spawn.z > spec.checkpoints[last - 1]);

  course.dispose();
});

test('Player.rollbackCheckpoint вперёд не двигает и мусор не принимает', () => {
  const scene = new THREE.Scene(),
    effects = new Effects(scene, 'low'),
    course = new Course(scene, courseSpec(778, 'normal'), { quality: 'low' }),
    player = new Player(scene, course, effects);

  player.checkpoint = 2;
  assert.equal(player.rollbackCheckpoint(5), false, 'откат не должен работать как выдача чекпоинтов');
  assert.equal(player.checkpoint, 2);

  assert.equal(player.rollbackCheckpoint(-3), true);
  assert.equal(player.checkpoint, 0);

  course.dispose();
});
