import * as THREE from 'three';
import { Character } from '../Character.js';

// Превью образа в шкафу.
//
// Главное требование — паритет: превью обязано показывать ровно то, что увидят в забеге. Поэтому
// здесь нет ни собственной модели персонажа, ни отдельного набора «иконок»: превью создаёт тот же
// `Character` и тот же `CosmeticRenderer`, что и игра. Разойтись им негде — кода, который мог бы
// разойтись, просто нет.
//
// Второе требование — примерка без надевания. Превью принимает произвольный образ, включая
// закрытые предметы, и НИЧЕГО не сохраняет: equip проходит отдельно, через server-authoritative
// путь. Посмотреть на закрытое можно, получить его так — нельзя.

const AUTO_ROTATE_DELAY = 2.6;
const AUTO_ROTATE_SPEED = 0.42;

export class CosmeticPreview {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{reducedMotion?: boolean, quality?: string}} options
   */
  constructor(canvas, { reducedMotion = false, quality = 'high' } = {}) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.disposed = false;
    this.idle = 0;
    this.angle = 0.5;
    this.targetAngle = 0.5;
    this.dragging = false;
    this.lastPointerX = 0;
    this.clock = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality !== 'low',
      alpha: true,
      powerPreference: 'low-power'
    });
    // Превью — маленькая картинка в интерфейсе, и полное разрешение экрана ей не нужно. Потолок в
    // два устройства-пикселя заметно дешевле на телефонах с плотным экраном.
    this.renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
    this.camera.position.set(0, 1.55, 5.4);
    this.camera.lookAt(0, 1.05, 0);

    this.scene.add(new THREE.HemisphereLight(0xf3e9ff, 0x3a2a6b, 1.45));
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(2.4, 4.2, 3.6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9ad7ff, 0.65);
    rim.position.set(-3, 2, -3.4);
    this.scene.add(rim);

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    this.character = new Character(this.pivot, { name: '', remote: false, cosmetics: null });
    this.character.group.position.set(0, 0, 0);

    this.bindPointer();
    this.resize();
  }

  bindPointer() {
    const start = event => {
      this.dragging = true;
      this.idle = 0;
      this.lastPointerX = event.clientX ?? event.touches?.[0]?.clientX ?? 0;
      this.canvas.setPointerCapture?.(event.pointerId);
    };
    const move = event => {
      if (!this.dragging) return;
      const x = event.clientX ?? event.touches?.[0]?.clientX ?? 0;
      this.targetAngle += (x - this.lastPointerX) * 0.011;
      this.lastPointerX = x;
      this.idle = 0;
      event.preventDefault();
    };
    const end = event => {
      this.dragging = false;
      this.canvas.releasePointerCapture?.(event?.pointerId);
    };
    this.handlers = { start, move, end };
    this.canvas.addEventListener('pointerdown', start);
    this.canvas.addEventListener('pointermove', move, { passive: false });
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', end);
  }

  /** Примерка. Ничего не сохраняет и ничего не отправляет — только показывает. */
  setLoadout(loadout) {
    if (this.disposed) return;
    this.character.setCosmetics(loadout || {});
  }

  /** Проигрывает эмоцию прямо в превью: выбирать её вслепую по названию неудобно. */
  playEmote(emoteId) {
    if (this.disposed) return false;
    return this.character.playEmote(emoteId);
  }

  playFinish() {
    if (this.disposed) return false;
    return Boolean(this.character.cosmetics?.playFinish());
  }

  resetRotation() {
    this.targetAngle = 0.5;
    this.idle = 0;
  }

  setReducedMotion(reduced) {
    this.reducedMotion = Boolean(reduced);
  }

  resize() {
    if (this.disposed) return;
    const width = Math.max(80, this.canvas.clientWidth || 320);
    const height = Math.max(80, this.canvas.clientHeight || 320);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    if (this.disposed) return;
    this.clock += dt;
    this.idle += dt;
    // Автоповорот после бездействия — и он же первым отключается при `prefers-reduced-motion`:
    // непрерывно вращающаяся модель для части игроков не украшение, а помеха.
    if (!this.dragging && !this.reducedMotion && this.idle > AUTO_ROTATE_DELAY) {
      this.targetAngle += dt * AUTO_ROTATE_SPEED;
    }
    this.angle = THREE.MathUtils.damp(this.angle, this.targetAngle, 9, dt);
    this.character.group.rotation.y = this.angle;

    // Персонаж в шкафу стоит: анимация покоя даёт лёгкое покачивание, а вторичное движение
    // аксессуаров работает тем же кодом, что и в забеге.
    this.character.animate(this.reducedMotion ? Math.min(dt, 1 / 60) * 0.25 : dt, {
      speed: 0,
      grounded: true,
      vertical: 0,
      diving: false
    });
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('pointerdown', this.handlers.start);
    this.canvas.removeEventListener('pointermove', this.handlers.move);
    this.canvas.removeEventListener('pointerup', this.handlers.end);
    this.canvas.removeEventListener('pointercancel', this.handlers.end);
    this.canvas.removeEventListener('pointerleave', this.handlers.end);
    this.character.dispose();
    // Собственные ресурсы персонажа превью: геометрии и материалы, созданные его конструктором.
    // Общий косметический кэш при этом не трогается — им пользуется вся сцена игры.
    this.scene.traverse(object => {
      if (!object.isMesh && !object.isSprite) return;
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
      else object.material?.dispose?.();
    });
    this.renderer.dispose();
  }
}
