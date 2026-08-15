import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Character } from '../client/game/Character.js';
import { PLAYER_RADIUS } from '../client/game/PlayerCollisions.js';
import {
  PLAYER_VISUAL_SCALE,
  PLAYER_FOOT,
  PLAYER_BODY_RADIUS,
  PLAYER_OBSTACLE_RADIUS,
  PLAYER_CROWD_RADIUS
} from '../client/game/PlayerDimensions.js';

test('визуальный и физический размер игрока уменьшены вместе ровно на 20%', () => {
  assert.equal(PLAYER_VISUAL_SCALE, 0.8);
  assert.equal(PLAYER_FOOT, 0.48 * 0.8);
  assert.equal(PLAYER_BODY_RADIUS, 0.48 * 0.8);
  assert.equal(PLAYER_OBSTACLE_RADIUS, 0.42 * 0.8);
  assert.equal(PLAYER_CROWD_RADIUS, 0.72 * 0.8);
  assert.equal(PLAYER_RADIUS, PLAYER_CROWD_RADIUS);

  const scene = new THREE.Scene();
  const character = new Character(scene);
  assert.equal(character.group.scale.x, 0.8);
  assert.equal(character.group.scale.y, 0.8);
  assert.equal(character.group.scale.z, 0.8);
  character.dispose();
});
