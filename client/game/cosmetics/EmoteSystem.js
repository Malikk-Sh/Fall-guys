import * as THREE from 'three';
import { COSMETIC_BY_ID } from '/shared/cosmetics.js';
import { buildAccessory } from './AccessoryFactory.js';

// Эмоции.
//
// Три вещи, которых эмоция делать не должна, и они закреплены здесь конструкцией, а не обещанием:
//
// 1. Не трогает игровое состояние. Система получает Character — модель, — и меняет только повороты
//    и смещения внутри `visual`. Позиция группы персонажа, которую читает физика и снапшот,
//    остаётся нетронутой.
// 2. Не бьёт и не толкает. Здесь нет ни одного обращения к столкновениям, импульсам или коллайдерам.
// 3. Не удерживает управление. Прыжок, подкат и смена состояния забега мгновенно прерывают позу.
//
// Анимация — последовательность поз на существующем скелете персонажа, без скелетного фреймворка:
// у Wobbler четыре конечности и корпус, и этого достаточно для узнаваемого движения.

const lerp = THREE.MathUtils.lerp;
// Плавный вход и выход: без него поза «защёлкивается» и выглядит сбоем, а не движением.
const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// Каждая поза — функция от нормализованного времени. Возвращать ничего не нужно: она пишет
// в переданный набор каналов, а применяет их система.
const MOTIONS = {
  moonwalk(t, out) {
    const step = Math.sin(t * Math.PI * 6);
    out.leftLeg = step * 0.9;
    out.rightLeg = -step * 0.9;
    out.leftArm = -step * 0.4;
    out.rightArm = step * 0.4;
    out.leanX = 0.16;
    out.shiftZ = Math.sin(t * Math.PI) * 0.5;
    out.spinY = Math.sin(t * Math.PI * 2) * 0.12;
  },
  kiss(t, out) {
    const reach = Math.sin(Math.min(1, t * 1.8) * Math.PI);
    out.rightArm = -2.1 * reach;
    out.leftArm = 0.25 * reach;
    out.bounce = Math.sin(t * Math.PI * 3) * 0.05;
    out.spinY = reach * 0.3;
  },
  dance(t, out) {
    const beat = Math.sin(t * Math.PI * 8);
    out.leftArm = -1.5 + beat * 0.7;
    out.rightArm = -1.5 - beat * 0.7;
    out.leftLeg = beat * 0.4;
    out.rightLeg = -beat * 0.4;
    out.bounce = Math.abs(Math.sin(t * Math.PI * 8)) * 0.13;
    out.tiltZ = beat * 0.16;
  },
  robot(t, out) {
    // Ступенчато: значения квантуются по восьми шагам, поэтому движение идёт рывками — это и есть
    // «робот». Никакой случайности, ровная сетка.
    const step = Math.floor(t * 8) / 8;
    const flip = Math.floor(t * 8) % 2 === 0;
    out.leftArm = flip ? -1.6 : -0.2;
    out.rightArm = flip ? -0.2 : -1.6;
    out.spinY = (step - 0.5) * 0.9;
    out.tiltZ = flip ? 0.12 : -0.12;
  },
  yoho(t, out) {
    const swing = Math.sin(t * Math.PI * 4);
    out.rightArm = -2.4;
    out.leftArm = swing * 0.5;
    out.tiltZ = swing * 0.28;
    out.bounce = Math.abs(swing) * 0.1;
    out.spinY = swing * 0.4;
  },
  telescope(t, out) {
    const raise = Math.sin(Math.min(1, t * 2.2) * Math.PI * 0.5);
    out.rightArm = -1.9 * raise;
    out.leftArm = 0.2 * raise;
    out.leanX = -0.1 * raise;
    out.spinY = Math.sin(t * Math.PI * 2) * 0.5;
    out.prop = raise;
  }
};

const EMPTY = {
  leftArm: 0,
  rightArm: 0,
  leftLeg: 0,
  rightLeg: 0,
  bounce: 0,
  tiltZ: 0,
  leanX: 0,
  spinY: 0,
  shiftZ: 0,
  prop: 0
};

export class EmoteSystem {
  constructor(character) {
    this.character = character;
    this.item = null;
    this.motion = null;
    this.time = 0;
    this.duration = 0;
    this.prop = null;
    // Один переиспользуемый объект каналов: поза считается каждый кадр, и создавать под неё
    // объект означало бы аллокацию в кадре у каждого играющего эмоцию персонажа.
    this._out = { ...EMPTY };
  }

  get active() {
    return Boolean(this.motion);
  }

  /**
   * Запускает эмоцию по каноническому ID. Незнакомый ID, чужой слот и неизвестное движение молча
   * игнорируются: сюда приходят и сетевые события, а падать из-за чужого сообщения нельзя.
   */
  play(emoteId) {
    const item = COSMETIC_BY_ID[emoteId];
    if (!item || item.slot !== 'emote') return false;
    const motion = MOTIONS[item.render?.motion];
    if (!motion) return false;

    this.stop();
    this.item = item;
    this.motion = motion;
    this.duration = Math.min(3.5, Math.max(1.2, Number(item.render.duration) || 2));
    this.time = 0;

    if (item.render.prop) {
      this.prop = buildAccessory(item);
      this.prop.position.set(0.55, 1.05, -0.3);
      this.prop.visible = false;
      this.character.visual.add(this.prop);
    }
    return true;
  }

  /** Прерывание. Вызывается прыжком, подкатом и любой сменой состояния забега. */
  stop() {
    if (this.prop) {
      this.character.visual.remove(this.prop);
      this.prop = null;
    }
    if (this.motion) {
      this.character.visual.position.z = 0;
      this.character.visual.rotation.y = 0;
    }
    this.motion = null;
    this.item = null;
    this.time = 0;
  }

  update(dt) {
    if (!this.motion) return;
    this.time += dt;
    const raw = Math.min(1, this.time / this.duration);
    if (raw >= 1) {
      this.stop();
      return;
    }

    const out = this._out;
    Object.assign(out, EMPTY);
    this.motion(raw, out);

    // Затухание к краям: эмоция начинается и заканчивается из нейтральной позы.
    const blend = ease(Math.min(1, Math.min(raw, 1 - raw) * 6));
    const character = this.character;
    character.leftArm.rotation.x = lerp(0, out.leftArm, blend);
    character.rightArm.rotation.x = lerp(0, out.rightArm, blend);
    character.leftLeg.rotation.x = lerp(0, out.leftLeg, blend);
    character.rightLeg.rotation.x = lerp(0, out.rightLeg, blend);
    character.visual.position.y = lerp(0, out.bounce, blend);
    character.visual.position.z = lerp(0, out.shiftZ, blend);
    character.visual.rotation.z = lerp(0, out.tiltZ, blend);
    character.visual.rotation.x = lerp(0, out.leanX, blend);
    character.visual.rotation.y = lerp(0, out.spinY, blend);
    if (this.prop) this.prop.visible = out.prop * blend > 0.25;
  }

  dispose() {
    this.stop();
  }
}
