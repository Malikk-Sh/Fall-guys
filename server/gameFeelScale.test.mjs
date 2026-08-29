import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Character } from '../client/game/Character.js';
import { Effects } from '../client/game/Effects.js';
import { flowSignal, nearMissSample, placeDirection } from '../client/game/FeedbackController.js';
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
  assert.deepEqual(flowSignal({ ...base, rolling: true }, { ...base, grounded: false, vertical: 8 }), {
    id: 'roll-jump',
    label: 'ПОТОК ×2',
    tone: 'yellow',
    strength: 0.62
  });
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

test('procedural character lean остаётся visual-only и реагирует на разгон и поворот', () => {
  const scene = new THREE.Scene();
  const character = new Character(scene);
  character.phase = 0;
  character.animate(1 / 60, { speed: 0, grounded: true });
  character.group.rotation.y = 0.32;
  character.animate(1 / 60, { speed: 7, grounded: true });

  const forwardLean = character.visual.rotation.x;
  const turnLean = Math.abs(character.visual.rotation.z);
  const faceLag = Math.abs(character.faceAnchor.rotation.z);
  const visualScale = character.group.scale.x;
  assert.ok(forwardLean < 0);
  assert.ok(turnLean > 0.005);
  assert.ok(faceLag > 0.001);
  assert.equal(visualScale, PLAYER_VISUAL_SCALE);
  character.dispose();
});

test('air pose различает подъём и падение без изменения gameplay state', () => {
  const scene = new THREE.Scene();
  const rising = new Character(scene);
  const falling = new Character(scene);
  rising.phase = 0;
  falling.phase = 0;

  for (let i = 0; i < 20; i++) {
    rising.animate(1 / 60, { speed: 5, grounded: false, vertical: 8 });
    falling.animate(1 / 60, { speed: 5, grounded: false, vertical: -9 });
  }

  const risingArm = rising.leftArm.rotation.x;
  const fallingArm = falling.leftArm.rotation.x;
  const risingLeg = rising.leftLeg.rotation.x;
  const fallingLeg = falling.leftLeg.rotation.x;
  assert.ok(risingArm < fallingArm - 0.2);
  assert.ok(fallingLeg > risingLeg + 0.15);
  rising.dispose();
  falling.dispose();
});

test('get-up получает короткий visual pop, а immunity glow остаётся слабым и обратимым', () => {
  const scene = new THREE.Scene();
  const character = new Character(scene);
  character.animate(1 / 60, { speed: 0, grounded: true, knockedDown: true });
  character.animate(1 / 60, { speed: 0, grounded: true, recovering: true });
  assert.ok(character.getupPulse > 0);

  character.setImmunityGlow(true);
  const glow = character.bodyMesh.material.emissiveIntensity;
  assert.ok(glow > 0);
  assert.ok(glow < 0.25);
  character.setImmunityGlow(false);
  assert.equal(character.bodyMesh.material.emissiveIntensity, 0);
  character.dispose();
});

test('near miss использует внешний halo spinner и не путает его с попаданием', () => {
  const spinner = {
    type: 'spinner',
    angle: 0,
    length: 4,
    width: 0.8,
    center: { x: 0, y: 1, z: 0 },
    mesh: { uuid: 'spinner' }
  };
  const near = nearMissSample(spinner, { x: 0, y: 1, z: 0.8 });
  assert.equal(near?.key, 'spinner');
  assert.ok(near.gap > 0 && near.gap < 0.48);
  assert.equal(nearMissSample(spinner, { x: 0, y: 1, z: 0.7 })?.inside, true);
  assert.equal(nearMissSample(spinner, { x: 0, y: 1, z: 1.4 }), null);
});

test('near miss поддерживает puncher и игнорирует неподходящие препятствия', () => {
  const puncher = {
    type: 'puncher',
    w: 1,
    d: 1,
    mesh: { uuid: 'puncher', position: { x: 0, y: 1, z: 0 } }
  };
  const near = nearMissSample(puncher, { x: 0.95, y: 1, z: 0 });
  assert.equal(near?.key, 'puncher');
  assert.equal(near?.side, 1);
  assert.equal(nearMissSample({ type: 'bumper' }, { x: 0, y: 0, z: 0 }), null);
});

test('semantic obstacle effects различаются, переиспользуют pool и держат low-quality budget', () => {
  const scene = new THREE.Scene();
  const effects = new Effects(scene, 'low');
  const at = new THREE.Vector3(2, 3, -4);
  try {
    effects.spring(at, 0xffd94b);
    assert.ok(effects.items.length > 0);
    assert.ok(effects.items.every(mesh => mesh.userData.profile === 'spring'));
    assert.ok(effects.items.every(mesh => mesh.userData.velocity.y >= 4.4));
    const springMeshes = new Set(effects.items);

    effects.clear();
    assert.equal(effects.items.length, 0);
    assert.equal(effects.pool.length, springMeshes.size);

    effects.bumper(at, 0xff5a9e);
    assert.ok(effects.items.every(mesh => mesh.userData.profile === 'bumper'));
    assert.ok(
      effects.items.every(mesh => Math.hypot(mesh.userData.velocity.x, mesh.userData.velocity.z) >= 3.5)
    );
    assert.ok(effects.items.some(mesh => springMeshes.has(mesh)), 'bumper должен переиспользовать pool');

    effects.clear();
    effects.spinner(at, 0xffd94b);
    assert.ok(effects.items.every(mesh => mesh.userData.profile === 'spinner'));
    assert.ok(effects.items.every(mesh => mesh.userData.velocity.y >= 0.3 && mesh.userData.velocity.y <= 1.2));

    effects.clear();
    effects.puncher(at, 0xff5a9e);
    assert.ok(effects.items.every(mesh => mesh.userData.profile === 'puncher'));
    assert.ok(
      effects.items.every(mesh => Math.hypot(mesh.userData.velocity.x, mesh.userData.velocity.z) >= 4.5)
    );

    effects.clear();
    effects.burst(at, 0xffffff, 100, 1);
    assert.equal(effects.items.length, 34, 'даже большой burst не должен пробить low-quality cap');
    assert.ok(effects.items.every(mesh => mesh.geometry === effects.geometry));
  } finally {
    effects.dispose();
  }
});
