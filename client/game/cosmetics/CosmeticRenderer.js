import * as THREE from 'three';
import { cosmeticDetailMode } from '/shared/cosmetics.js';
import { buildAccessory } from './AccessoryFactory.js';
import { AccessoryAnimator } from './AccessoryAnimator.js';
import { createTrail } from './TrailSystem.js';
import { FinishEffectSystem } from './FinishEffectSystem.js';
import { EmoteSystem } from './EmoteSystem.js';
import { standardMaterial } from './CosmeticResources.js';

// Оркестратор косметики одного персонажа.
//
// Character остался моделью Wobbler и ничего не знает ни об одном из шестидесяти предметов: он даёт
// якоря и базовые детали, а что и куда надевать — решает этот слой по данным каталога. Именно это
// и означает требование «не превращать Character.js в switch по шестидесяти ID»: switch здесь тоже
// нет — есть таблица render kinds в фабрике и одинаковая для всех процедура крепления.

const SLOT_ANCHORS = Object.freeze({
  body: 'bodyAnchor',
  visor: 'faceAnchor',
  antenna: 'headAnchor',
  back: 'backAnchor'
});

// Хэш строки в число: фаза колебаний должна отличаться у разных игроков, но быть постоянной у
// одного. Math.random() дал бы разное значение при каждой пересборке модели.
function seedFrom(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return ((hash % 628) / 100) * Math.PI;
}

export class CosmeticRenderer {
  /**
   * @param {import('../Character.js').Character} character
   * @param {object} loadout {slot: item|null}
   * @param {{remote?: boolean, detail?: string, seed?: string}} options
   */
  constructor(character, loadout = null, { remote = false, detail = 'full', seed = '' } = {}) {
    this.character = character;
    this.scene = character.scene;
    this.remote = remote;
    this.detail = detail;
    this.seed = seedFrom(String(seed || character.name || 'wobbler'));

    this.attachments = new Map();
    this.animators = [];
    this.ownMaterials = [];
    this.trail = null;
    this.trailItem = null;
    this.finishEffects = new FinishEffectSystem(this.scene);
    this.emotes = new EmoteSystem(character);
    this.loadout = {};
    this.phase = this.seed;
    // Переиспользуемая позиция для следа: он живёт в мировых координатах, и брать её надо каждый
    // кадр, но создавать под это вектор — нет.
    this._worldPosition = new THREE.Vector3();

    this.apply(loadout);
  }

  // ── Крепление ─────────────────────────────────────────────────────────────────────────────

  apply(loadout) {
    const next = loadout || {};
    for (const slot of ['body', 'visor', 'antenna', 'back']) {
      const item = next[slot] || null;
      if (this.loadout[slot]?.id === item?.id) continue;
      this.detach(slot);
      this.loadout[slot] = item;
      this.attach(slot, item);
    }
    this.applyTrail(next.trail || null);
    this.loadout.trail = next.trail || null;
    this.loadout.finish = next.finish || null;
    this.refreshVisibility();
  }

  attach(slot, item) {
    // Тело — особый случай: оно не «надевается», а перекрашивает самого Wobbler. Накладки
    // (воротники, слои, рёбра) при этом крепятся как обычный аксессуар.
    if (slot === 'body') this.applyBodyColors(item);
    // Визор и голова имеют базовые детали персонажа. Унаследованные предметы перекрашивают их,
    // новые — прячут и ставят свою геометрию. Так старые предметы выглядят ровно как прежде.
    if (slot === 'visor') this.applyFaceBase(item);
    if (slot === 'antenna') {
      this.applyHeadBase(item);
      // Унаследованная антенна — это и есть базовая деталь персонажа. Собирать её повторно
      // фабрикой значило бы надеть вторую антенну поверх первой.
      if (!item || item.render?.kind === 'head-antenna') return;
    }
    if (!item) return;

    const anchorName = SLOT_ANCHORS[slot];
    const anchor = this.character[anchorName];
    if (!anchor) return;
    const group = buildAccessory(item);
    if (!group.children.length) return;

    anchor.add(group);
    this.attachments.set(slot, group);
    group.traverse(object => {
      if (object.userData?.ownMaterial) this.ownMaterials.push(object.material);
    });
    const animator = new AccessoryAnimator(group, item.render?.motion || {}, this.seed + anchor.position.y);
    if (animator.active) this.animators.push(animator);
    group.userData.animator = animator;
  }

  detach(slot) {
    const group = this.attachments.get(slot);
    if (!group) return;
    group.parent?.remove(group);
    this.attachments.delete(slot);
    const animator = group.userData.animator;
    if (animator) {
      const index = this.animators.indexOf(animator);
      if (index >= 0) this.animators.splice(index, 1);
    }
  }

  applyBodyColors(item) {
    const render = item?.render || {};
    // Унаследованные `colors` продолжают читаться: у старых предметов render добавлен рядом, но
    // источником правды для них по-прежнему может быть colors.
    const primary = render.primary ?? item?.colors?.body ?? this.character.baseColor;
    const accent = render.accent ?? item?.colors?.accent ?? this.character.baseAccent;
    const belly = render.belly ?? accent;
    this.character.setBodyMaterials({ primary, accent, belly });
  }

  applyFaceBase(item) {
    const base = this.character.baseVisor;
    if (!base) return;
    const kind = item?.render?.kind;
    // Без предмета и с унаследованной пластиной базовый визор виден и перекрашивается.
    if (!item || kind === 'face-plate') {
      base.visible = true;
      base.material = standardMaterial(item?.render?.primary ?? item?.color ?? 0xdffcff, {
        roughness: 0.12,
        metalness: 0.1
      });
      return;
    }
    // Новые лицевые предметы ставят собственную геометрию: оставленный под ними базовый визор
    // торчал бы сквозь очки и повязку.
    base.visible = kind !== 'face-shades' && kind !== 'face-scan' && kind !== 'face-nebula';
  }

  applyHeadBase(item) {
    const base = this.character.baseAntenna;
    if (!base) return;
    const kind = item?.render?.kind;
    if (!item || kind === 'head-antenna') {
      // Базовая антенна и есть унаследованный предмет: её геометрию дублировать незачем.
      base.visible = true;
      const color = item?.render?.primary ?? item?.color ?? this.character.baseAccent;
      this.character.setAntennaColor(color);
      return;
    }
    base.visible = false;
  }

  applyTrail(item) {
    if (this.trailItem?.id === item?.id) return;
    this.trail?.dispose();
    this.trail = null;
    this.trailItem = item || null;
    if (!item) return;
    this.trail = createTrail(this.scene, item, { detail: this.detail });
  }

  // ── Кадр ──────────────────────────────────────────────────────────────────────────────────

  /**
   * @param {number} dt
   * @param {{speed:number, grounded:boolean, vertical:number, diving:boolean, state:string}} motion
   */
  update(dt, motion = {}) {
    this.phase += dt;
    this.emotes.update(dt);
    this.finishEffects.update(dt);
    if (this.detail === 'minimal') return;

    for (const animator of this.animators) animator.update(dt, motion);

    if (this.trail) {
      this.character.group.getWorldPosition(this._worldPosition);
      this.trail.update(dt, this._worldPosition, {
        speed: motion.speed || 0,
        grounded: motion.grounded !== false,
        diving: Boolean(motion.diving),
        rotationY: this.character.group.rotation.y,
        phase: this.phase
      });
    }
  }

  landed(strength = 1) {
    for (const animator of this.animators) animator.landed(strength);
  }

  /**
   * Эмоция. Возвращает false, если ID не подошёл: вызывающему это нужно, чтобы не отправлять в
   * сеть то, что даже локально не проигралось.
   */
  playEmote(emoteId) {
    if (this.detail === 'minimal') return false;
    return this.emotes.play(emoteId);
  }

  /** Прерывание эмоции: прыжок, подкат, смена состояния забега. */
  cancelEmote() {
    this.emotes.stop();
  }

  get emoteActive() {
    return this.emotes.active;
  }

  /**
   * Победная презентация. Запускается ТОЛЬКО после подтверждённого сервером финиша — сам эффект
   * ничего не подтверждает и не объявляет.
   */
  playFinish(item = this.loadout.finish) {
    if (!item) return false;
    this.character.group.getWorldPosition(this._worldPosition);
    return this.finishEffects.play(item, this._worldPosition, {
      remote: this.remote,
      detail: this.detail
    });
  }

  cancelFinish() {
    this.finishEffects.cancel();
  }

  // ── Детализация ───────────────────────────────────────────────────────────────────────────

  setDetail(level) {
    if (this.detail === level) return;
    this.detail = level;
    this.trail?.setDetail(level);
    if (level === 'minimal') {
      this.emotes.stop();
      this.finishEffects.cancel();
      for (const animator of this.animators) animator.reset();
    }
    this.refreshVisibility();
  }

  // Что видно на текущем уровне. Правило берётся у самого предмета (`performance`), а умолчания —
  // из общей таблицы: повторять «minimal: hidden» у каждой дешёвой мелочи не нужно.
  refreshVisibility() {
    for (const [slot, group] of this.attachments) {
      const item = this.loadout[slot];
      const mode = cosmeticDetailMode(item, this.detail);
      group.visible = mode !== 'hidden';
      // `reduced` прячет только помеченные «дорогими» части: свечение, частицы, полупрозрачность.
      // Силуэт предмета остаётся — иначе на среднем качестве игрок терял бы образ целиком.
      group.traverse(object => {
        if (object.userData?.cosmeticRole && REDUCIBLE_ROLES.has(object.userData.cosmeticRole)) {
          object.visible = mode === 'full';
        }
      });
      group.castShadow = this.detail === 'full';
    }
    // Базовые детали персонажа. Их видимость решает косметика, а не общий LOD: смена уровня
    // детализации у Character включает всё подряд, и без этой поправки из «minimal» возвращался бы
    // базовый визор поверх надетых очков и базовая антенна внутри короны.
    if (this.detail !== 'minimal') {
      this.applyFaceBase(this.loadout.visor || null);
      this.applyHeadBase(this.loadout.antenna || null);
    }
    const faceItem = this.loadout.visor;
    if (this.character.baseVisor && faceItem && cosmeticDetailMode(faceItem, this.detail) === 'hidden') {
      this.character.baseVisor.visible = true;
    }
  }

  dispose() {
    for (const slot of [...this.attachments.keys()]) this.detach(slot);
    this.animators.length = 0;
    this.trail?.dispose();
    this.trail = null;
    this.finishEffects.dispose();
    this.emotes.dispose();
    // Освобождаются только собственные материалы аксессуаров — те, у которых своя текстура.
    // Кэшированные общие ресурсы пережить персонажа обязаны: ими пользуются остальные игроки.
    for (const material of this.ownMaterials) material.dispose();
    this.ownMaterials.length = 0;
  }
}

// Части, которые исчезают на `reduced`: всё, что стоит заметно дороже статичной геометрии.
const REDUCIBLE_ROLES = new Set(['orbit', 'glitch', 'ripple', 'swirl', 'pulse']);
