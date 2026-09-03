import assert from 'node:assert/strict';
import test from 'node:test';
import { Music, MUSIC_MODE, musicLayerTargets } from '../client/audio/Music.js';

function fakeEngine(ready = true) {
  const nodes = [];
  const ctx = {
    currentTime: 12,
    createGain() {
      const targets = [];
      const node = {
        targets,
        gain: {
          value: 0,
          cancelScheduledValues() {},
          setTargetAtTime(value, time, constant) {
            targets.push({ value, time, constant });
          }
        },
        connect() {}
      };
      nodes.push(node);
      return node;
    }
  };
  return { ready, ctx, musicBus: {}, nodes };
}

const latestTarget = layer => layer.targets.at(-1)?.value;

test('menu music keeps a quiet fixed layer balance while race intensity still opens its layers', () => {
  assert.deepEqual(musicLayerTargets(MUSIC_MODE.MENU, 0), {
    bass: 0.16,
    drums: 0.04,
    chords: 0.22,
    lead: 0.08
  });
  assert.deepEqual(
    musicLayerTargets(MUSIC_MODE.MENU, 1),
    musicLayerTargets(MUSIC_MODE.MENU, 0),
    'последняя интенсивность гонки не должна превращать меню в кульминацию'
  );
  assert.equal(
    musicLayerTargets(MUSIC_MODE.MENU, 1),
    musicLayerTargets(MUSIC_MODE.MENU, 0),
    'hot loop должен переиспользовать готовый профиль без новых объектов'
  );
  assert.deepEqual(musicLayerTargets(MUSIC_MODE.RACE, 1), {
    bass: 0.5,
    drums: 0.42,
    chords: 0.3,
    lead: 0.26
  });
  assert.equal(
    musicLayerTargets(MUSIC_MODE.RACE, 0.9),
    musicLayerTargets(MUSIC_MODE.RACE, 1),
    'race hot loop тоже должен читать готовый threshold-профиль'
  );
});

test('switching menu to race reuses one scheduler and applies the race mix', t => {
  const engine = fakeEngine();
  const music = new Music(engine);
  t.after(() => music.stop());

  music.setIntensity(1);
  music.start(MUSIC_MODE.MENU);
  const timer = music.timer;

  assert.equal(music.playing, true);
  assert.equal(music.mode, MUSIC_MODE.MENU);
  assert.deepEqual(Object.values(music.layers).map(latestTarget), [0.16, 0.04, 0.22, 0.08]);

  music.start(MUSIC_MODE.RACE);

  assert.equal(music.timer, timer, 'смена темы не должна создавать второй setInterval');
  assert.equal(music.mode, MUSIC_MODE.RACE);
  assert.equal(music.step, 0);
  assert.equal(music.nextNoteTime, engine.ctx.currentTime + 0.06);
  assert.deepEqual(Object.values(music.layers).map(latestTarget), [0.5, 0.42, 0.3, 0.26]);
});

test('menu mode can be selected before the browser unlocks Web Audio', t => {
  const engine = fakeEngine(false);
  const music = new Music(engine);
  t.after(() => music.stop());

  music.start(MUSIC_MODE.MENU);
  assert.equal(music.mode, MUSIC_MODE.MENU);
  assert.equal(music.playing, false);
  assert.equal(music.timer, null);

  engine.ready = true;
  music.start(MUSIC_MODE.MENU);
  assert.equal(music.playing, true);
  assert.equal(music.mode, MUSIC_MODE.MENU);
});
