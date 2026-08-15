import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Player } from '../client/game/Player.js';

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
