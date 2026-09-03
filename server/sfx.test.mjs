import assert from 'node:assert/strict';
import test from 'node:test';
import { Sfx } from '../client/audio/sfx.js';
import { menuSoundForAction } from '../client/ui/menuBindings.js';

function recordingEngine() {
  const tones = [];
  const noises = [];
  return {
    tones,
    noises,
    playTone(options) {
      tones.push(options);
    },
    playNoise(options) {
      noises.push(options);
    },
    throttle() {
      return true;
    }
  };
}

test('menu click, confirm and back have distinct directional signatures', () => {
  const engine = recordingEngine();
  const sfx = new Sfx(engine);

  sfx.uiClick();
  assert.deepEqual(engine.tones.splice(0), [{ freq: 880, type: 'square', duration: 0.05, volume: 0.09 }]);

  sfx.uiConfirm();
  const confirm = engine.tones.splice(0);
  assert.equal(confirm.length, 2);
  assert.ok(confirm[0].freq < confirm[1].freq, 'подтверждение должно подниматься по высоте');
  assert.ok(confirm.every(tone => tone.duration <= 0.14));

  sfx.uiBack();
  const back = engine.tones.splice(0);
  assert.equal(back.length, 1);
  assert.ok(Array.isArray(back[0].freq));
  assert.ok(back[0].freq[0] > back[0].freq[1], 'возврат должен опускаться по высоте');
  assert.ok(back[0].duration <= 0.14);
  assert.equal(engine.noises.length, 0, 'частые menu SFX не должны добавлять шумовой хвост');
});

test('menu actions map confirmations and cancellations to their semantic sound', () => {
  assert.equal(menuSoundForAction('#play'), 'uiConfirm');
  assert.equal(menuSoundForAction('#coopCreate'), 'uiConfirm');
  assert.equal(menuSoundForAction('#raceFind'), 'uiConfirm');
  assert.equal(menuSoundForAction('#raceFind', { searching: true }), 'uiBack');
  assert.equal(menuSoundForAction('#coopFind', { searching: true }), 'uiBack');
  assert.equal(menuSoundForAction('#returnLobby'), 'uiBack');
  assert.equal(menuSoundForAction('#quality'), 'uiClick');
  assert.equal(menuSoundForAction('hostile-selector', { searching: true }), 'uiClick');
});
