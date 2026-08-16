// Рендерер косметики: сборка, детализация, уборка.
//
// Тест намеренно строит ВСЕ шестьдесят предметов, а не выборку. Каталог — данные, и предмет с
// опечаткой в параметрах не падает, а тихо превращается в пустую группу: на глаз это заметит
// только тот, кто откроет именно его. Здесь это ловится на каждой сборке.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  COSMETIC_BY_ID,
  COSMETIC_CATALOG,
  NEW_COSMETIC_IDS,
  cosmeticDetailMode
} from '../shared/cosmetics.js';
import { buildAccessory } from '../client/game/cosmetics/AccessoryFactory.js';
import { AccessoryAnimator } from '../client/game/cosmetics/AccessoryAnimator.js';
import { GhostTrail, TrailSystem, createTrail } from '../client/game/cosmetics/TrailSystem.js';
import { FinishEffectSystem } from '../client/game/cosmetics/FinishEffectSystem.js';
import { EmoteSystem } from '../client/game/cosmetics/EmoteSystem.js';
import { cosmeticResourceStats } from '../client/game/cosmetics/CosmeticResources.js';

// Минимальный canvas: процедурные текстуры рисуются на нём, а Node про DOM ничего не знает.
// Подменяется только document.createElement, и только для canvas — остального тесту не нужно.
const canvasStub = () => ({
  width: 0,
  height: 0,
  getContext: () => ({
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    fillText() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    fill() {},
    set fillStyle(_value) {},
    set font(_value) {},
    set textAlign(_value) {},
    set textBaseline(_value) {}
  })
});

globalThis.document = globalThis.document || { createElement: () => canvasStub() };

const meshCount = object => {
  let total = 0;
  object.traverse(child => {
    if (child.isMesh) total++;
  });
  return total;
};

// Похожие на аксессуар слоты: у них есть собственная геометрия. Следы, финиши и эмоции строятся
// своими системами и здесь проверяются отдельно.
const GEOMETRIC_SLOTS = new Set(['visor', 'antenna', 'back']);

test('каждый из шестидесяти новых предметов собирается и имеет видимое представление', () => {
  const shapes = new Map();
  for (const id of NEW_COSMETIC_IDS) {
    const item = COSMETIC_BY_ID[id];
    const group = buildAccessory(item);
    assert.ok(group instanceof THREE.Group, `${id}: собран как группа`);
    assert.equal(group.userData.cosmeticId, id);

    if (GEOMETRIC_SLOTS.has(item.slot)) {
      assert.ok(meshCount(group) > 0, `${id}: у предмета есть геометрия`);
    }
    // Отпечаток формы и цветов: если два предмета соберутся в буквально одинаковую модель, они
    // будут неразличимы в игре, и «шестьдесят предметов» окажутся преувеличением.
    if (GEOMETRIC_SLOTS.has(item.slot)) {
      const fingerprint = JSON.stringify([
        item.render.kind,
        meshCount(group),
        item.render.primary ?? null,
        item.render.secondary ?? null,
        item.render.style ?? null,
        item.render.points ?? null
      ]);
      assert.equal(shapes.has(fingerprint), false, `${id} неотличим от ${shapes.get(fingerprint)}`);
      shapes.set(fingerprint, id);
    }
  }
});

test('тела и мифические предметы различаются цветовой схемой', () => {
  const bodies = COSMETIC_CATALOG.filter(item => item.slot === 'body');
  const palettes = new Set();
  for (const item of bodies) {
    const key = `${item.render.primary}:${item.render.accent}:${item.render.belly ?? ''}`;
    assert.equal(palettes.has(key), false, `${item.id}: собственная палитра`);
    palettes.add(key);
  }
});

test('вторичное движение детерминировано и не дёргается случайно', () => {
  const item = COSMETIC_BY_ID['space-satellite-dish'];
  const build = () => {
    const group = buildAccessory(item);
    return new AccessoryAnimator(group, item.render.motion, 0.4);
  };
  const first = build();
  const second = build();
  const motion = { speed: 6, grounded: true, vertical: 0, diving: false, state: 'run' };
  for (let step = 0; step < 40; step++) {
    first.update(1 / 60, motion);
    second.update(1 / 60, motion);
  }
  // Два одинаково засеянных аниматора после одинаковых кадров обязаны совпасть до последнего
  // знака: случайность в кадре читалась бы как дефект, а не как жизнь.
  assert.equal(first.root.rotation.z, second.root.rotation.z);
  assert.equal(first.root.rotation.x, second.root.rotation.x);

  // Приземление даёт затухающий импульс, а не постоянное смещение.
  first.landed(1);
  assert.ok(first.landImpulse > 0);
  for (let step = 0; step < 120; step++) first.update(1 / 60, motion);
  assert.equal(first.landImpulse, 0);

  // reset возвращает деталь в покой: замороженная в перекошенной позе выглядит поломкой.
  first.reset();
  assert.equal(first.root.rotation.x, 0);
  assert.equal(first.root.rotation.z, 0);
});

test('след держит фиксированный бюджет частиц и не растёт со временем', () => {
  const scene = new THREE.Group();
  const trail = new TrailSystem(scene, COSMETIC_BY_ID['space-stardust-trail']);
  const position = new THREE.Vector3();
  const motion = { speed: 9, grounded: true, phase: 0 };

  for (let step = 0; step < 2000; step++) trail.update(1 / 60, position, motion);
  assert.ok(trail.liveCount <= trail.max, `живых частиц ${trail.liveCount} ≤ ${trail.max}`);
  assert.ok(trail.max <= 12, 'потолок на полной детализации не выше двенадцати');
  // Пул конечен: он растёт до потолка и дальше переиспользуется.
  assert.ok(trail.pool.length + trail.liveCount <= trail.max + 2, 'пул не разрастается');

  const fullMax = trail.max;
  trail.setDetail('simple');
  assert.ok(trail.max < fullMax && trail.max <= 6, 'на среднем качестве частиц вдвое меньше');
  trail.setDetail('minimal');
  assert.ok(trail.max <= 3, 'на низком качестве след почти исчезает');

  trail.dispose();
  assert.equal(trail.liveCount, 0);
  assert.equal(trail.pool.length, 0);
});

test('цифровые призраки не клонируют персонажа и убираются за собой', () => {
  const scene = new THREE.Group();
  const ghosts = createTrail(scene, COSMETIC_BY_ID['neon-ghost-trail']);
  assert.ok(ghosts instanceof GhostTrail);
  assert.ok(ghosts.ghosts.length <= 2, 'не больше двух силуэтов');

  const position = new THREE.Vector3();
  for (let step = 0; step < 600; step++) ghosts.update(1 / 60, position, { speed: 8 });
  assert.ok(ghosts.liveCount <= 2, 'одновременно живых силуэтов не больше двух');
  // Один силуэт — одна капсула, а не копия всей модели персонажа.
  for (const ghost of ghosts.ghosts) assert.equal(meshCount(ghost.mesh), 1);

  ghosts.dispose();
  assert.equal(ghosts.ghosts.length, 0);
});

test('следы каталога переживают сборку и уборку без утечки живых частиц', () => {
  const scene = new THREE.Group();
  const trails = COSMETIC_CATALOG.filter(item => item.slot === 'trail');
  assert.equal(trails.length, 11, 'три унаследованных следа плюс восемь новых');
  for (const item of trails) {
    const trail = createTrail(scene, item);
    const position = new THREE.Vector3();
    for (let step = 0; step < 240; step++) trail.update(1 / 60, position, { speed: 7, grounded: false });
    trail.dispose();
    assert.equal(trail.liveCount, 0, `${item.id}: после dispose живых частиц нет`);
  }
  assert.equal(scene.children.length, 0, 'сцена очищена полностью');
});

test('победные эффекты играют ограниченное время и отменяются из любой точки', () => {
  const scene = new THREE.Group();
  const effects = new FinishEffectSystem(scene);
  const finishes = COSMETIC_CATALOG.filter(item => item.slot === 'finish');

  for (const item of finishes) {
    const played = effects.play(item, new THREE.Vector3());
    if (item.render.kind === 'finish-glyph') {
      // Унаследованный финиш рисует интерфейс символом на карточке; сцены он не требует.
      assert.equal(played, false, `${item.id}: сцену не занимает`);
      continue;
    }
    assert.equal(played, true, `${item.id}: эффект запустился`);
    assert.ok(effects.duration >= 1.5 && effects.duration <= 3.5, `${item.id}: 1.5–3.5 секунды`);

    // Реванш посреди эффекта — обычное дело, а не исключение.
    effects.update(0.3);
    effects.cancel();
    assert.equal(effects.active, false);
    assert.equal(scene.children.length, 0, `${item.id}: сцена убрана после отмены`);
  }

  // Досмотр до конца тоже убирает за собой.
  effects.play(COSMETIC_BY_ID['space-portal-finish'], new THREE.Vector3());
  for (let step = 0; step < 400; step++) effects.update(1 / 60);
  assert.equal(effects.active, false);
  assert.equal(scene.children.length, 0);
});

test('удалённый и низкодетальный финиш упрощаются, а не отменяются', () => {
  const scene = new THREE.Group();
  const local = new FinishEffectSystem(scene);
  local.play(COSMETIC_BY_ID['food-popcorn-finish'], new THREE.Vector3());
  const richParts = local.parts.length;
  local.cancel();

  const remote = new FinishEffectSystem(scene);
  remote.play(COSMETIC_BY_ID['food-popcorn-finish'], new THREE.Vector3(), { remote: true });
  assert.ok(remote.parts.length < richParts, 'у удалённого игрока эффект дешевле');
  assert.ok(remote.parts.length > 0, 'но он всё-таки виден');
  remote.cancel();

  // На минимальной детализации эффект не запускается вовсе: там и персонажа-то почти не видно.
  const minimal = new FinishEffectSystem(scene);
  assert.equal(
    minimal.play(COSMETIC_BY_ID['food-popcorn-finish'], new THREE.Vector3(), { detail: 'minimal' }),
    false
  );
  assert.equal(scene.children.length, 0);
});

test('эмоция меняет только позу и не трогает положение персонажа', () => {
  // Модель персонажа подменена минимальной ригой: тест проверяет контракт эмоции, а не Character.
  const character = {
    group: new THREE.Group(),
    visual: new THREE.Group(),
    leftArm: new THREE.Group(),
    rightArm: new THREE.Group(),
    leftLeg: new THREE.Group(),
    rightLeg: new THREE.Group()
  };
  character.group.add(character.visual);
  character.group.position.set(3, 1, -7);
  const emotes = new EmoteSystem(character);

  assert.equal(emotes.play('classic'), false, 'не эмоция');
  assert.equal(emotes.play('definitely-not-a-cosmetic'), false, 'неизвестный ID');
  assert.equal(emotes.play('food-chefs-kiss'), true);
  assert.equal(emotes.active, true);

  for (let step = 0; step < 30; step++) emotes.update(1 / 60);
  // Поза изменилась…
  assert.notEqual(character.rightArm.rotation.x, 0);
  // …а положение персонажа в мире — нет. Именно это и отделяет эмоцию от игрового действия.
  assert.deepEqual(
    [character.group.position.x, character.group.position.y, character.group.position.z],
    [3, 1, -7]
  );

  // Прерывание возвращает нейтраль и снимает реквизит.
  emotes.stop();
  assert.equal(emotes.active, false);
  assert.equal(character.visual.position.z, 0);

  // Эмоция с реквизитом добавляет и убирает его сама.
  emotes.play('pirate-telescope');
  assert.ok(character.visual.children.length > 0);
  emotes.stop();
  assert.equal(character.visual.children.length, 0);

  // Дойдя до конца, эмоция гаснет сама.
  emotes.play('neon-robot-dance');
  for (let step = 0; step < 400; step++) emotes.update(1 / 60);
  assert.equal(emotes.active, false);
});

test('правила детализации: mythic дешевеет, дешёвое остаётся', () => {
  assert.equal(cosmeticDetailMode(COSMETIC_BY_ID['space-void'], 'full'), 'full');
  assert.equal(cosmeticDetailMode(COSMETIC_BY_ID['space-void'], 'simple'), 'reduced');
  assert.equal(cosmeticDetailMode(COSMETIC_BY_ID['pirate-captain-hat'], 'simple'), 'full');
  assert.equal(cosmeticDetailMode(COSMETIC_BY_ID['pirate-captain-hat'], 'minimal'), 'hidden');
  assert.equal(cosmeticDetailMode(null, 'full'), 'hidden');
});

test('общие геометрии и материалы переиспользуются между предметами', () => {
  // Собираем весь каталог дважды: второй проход не должен создать ни одного нового ресурса.
  for (const item of COSMETIC_CATALOG) buildAccessory(item);
  const first = cosmeticResourceStats();
  for (const item of COSMETIC_CATALOG) buildAccessory(item);
  const second = cosmeticResourceStats();
  assert.deepEqual(second, first, 'повторная сборка берёт всё из кэша');
  // Ресурсов заметно меньше, чем предметов: формы общие, различаются параметры.
  assert.ok(first.geometries < COSMETIC_CATALOG.length * 3, `геометрий ${first.geometries}`);
});
