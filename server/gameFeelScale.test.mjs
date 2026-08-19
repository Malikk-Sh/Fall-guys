import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Character } from '../client/game/Character.js';
import { flowSignal, placeDirection } from '../client/game/FeedbackController.js';
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

test('flow feedback распознаёт только локальные переходы движения и ничего не меняет в физике', () => {
  const base = {
    diving: false,
    rolling: false,
    landingRetention: 0,
    grounded: true,
    vertical: 0
  };

  assert.deepEqual(flowSignal({ ...base, diving: true }, { ...base, rolling: true }), {
    id: 'dive-roll',
    label: 'ЧИСТО',
    tone: 'cyan',
    strength: 0.45
  });
  assert.deepEqual(
    flowSignal({ ...base, rolling: true }, { ...base, grounded: false, vertical: 8 }),
    {
      id: 'roll-jump',
      label: 'ПОТОК ×2',
      tone: 'yellow',
      strength: 0.62
    }
  );
  assert.deepEqual(flowSignal(base, { ...base, landingRetention: 0.34 }), {
    id: 'fast-landing',
    label: 'МЯГКО',
    tone: 'mint',
    strength: 0.34
  });
  assert.equal(flowSignal(base, base), null);
});

test('place feedback различает обгон и потерю позиции без выдуманной позиции', () => {
  assert.equal(placeDirection(4, 3), 'up');
  assert.equal(placeDirection(2, 3), 'down');
  assert.equal(placeDirection(3, 3), null);
  assert.equal(placeDirection(null, 3), null);
  assert.equal(placeDirection(3, 0), null);
});
