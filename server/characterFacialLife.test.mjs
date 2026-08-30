import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Character } from '../client/game/Character.js';
import { PLAYER_VISUAL_SCALE } from '../client/game/PlayerDimensions.js';

const eyeHeight = character =>
  character.eyes.reduce((sum, eye) => sum + eye.scale.y, 0) / character.eyes.length;

function animateFrames(character, frames, state) {
  for (let i = 0; i < frames; i++) character.animate(1 / 60, state);
}

test('facial life даёт периодическое моргание без новых gameplay-состояний', () => {
  const scene = new THREE.Scene();
  const character = new Character(scene);
  character.phase = 0;

  let minimumEyeHeight = Infinity;
  for (let i = 0; i < 360; i++) {
    character.animate(1 / 60, { speed: 0, grounded: true });
    minimumEyeHeight = Math.min(minimumEyeHeight, eyeHeight(character));
  }

  assert.ok(minimumEyeHeight < 0.35, 'за шесть секунд должен случиться хотя бы один читаемый blink');
  assert.equal(character.group.scale.x, PLAYER_VISUAL_SCALE);
  assert.equal(character.group.scale.y, PLAYER_VISUAL_SCALE);
  assert.equal(character.group.scale.z, PLAYER_VISUAL_SCALE);
  character.dispose();
});

test('air и knockdown меняют только выражение глаз и возвращаются к нейтрали', () => {
  const scene = new THREE.Scene();
  const airborne = new Character(scene);
  const knocked = new Character(scene);
  airborne.phase = 0;
  knocked.phase = 0;

  animateFrames(airborne, 10, { speed: 5, grounded: false, vertical: 8 });
  const airEyes = eyeHeight(airborne);

  animateFrames(knocked, 10, { speed: 0, grounded: true, knockedDown: true });
  const knockedEyes = eyeHeight(knocked);

  assert.ok(airEyes > 1.04, 'на подъёме глаза должны чуть шире раскрыться');
  assert.ok(knockedEyes < 0.72, 'при knockdown нужен короткий читаемый squint');

  animateFrames(knocked, 36, { speed: 0, grounded: true, recovering: true });
  assert.ok(
    eyeHeight(knocked) > knockedEyes + 0.18,
    'после подъёма выражение должно вернуться к нейтрали'
  );
  assert.equal(knocked.group.scale.x, PLAYER_VISUAL_SCALE);

  airborne.dispose();
  knocked.dispose();
});
