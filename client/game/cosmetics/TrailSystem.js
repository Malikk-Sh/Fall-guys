import * as THREE from 'three';
import { basicMaterial, box, sphere, starGeometry, cylinder } from './CosmeticResources.js';

// Следы движения.
//
// Каждое требование здесь взято из конкретной ошибки, которую след может допустить на телефоне:
//
// • пул фиксированного размера — иначе массив частиц растёт со временем игры, а не с нагрузкой;
// • ни одной `new Geometry`/`new Material` в кадре — форма и материал берутся из общего кэша;
// • время жизни у каждой частицы — иначе очистка зависит от того, вспомнит ли о ней кто-нибудь;
// • плотность зависит от уровня детализации — шестнадцать игроков с полным следом это шестнадцать
//   потоков прозрачных частиц, а прозрачность на мобильной видеокарте дороже всего остального;
// • dispose() — след живёт короче сцены, и его меши обязаны уйти вместе с персонажем.

// Потолок живых частиц на один след. Ориентир из ТЗ: ~12 на full, 5–6 на simple, 0–3 на minimal.
const BUDGET = Object.freeze({ full: 12, reduced: 6, minimal: 3 });

const SHAPES = {
  spark: () => sphere(0.06, 6),
  star: () => starGeometry(0.055),
  square: () => box(0.075, 0.075, 0.075),
  crumb: () => box(0.05, 0.045, 0.05),
  sprinkle: () => box(0.03, 0.09, 0.03),
  coin: () => cylinder(0.07, 0.07, 0.02, 8),
  bubble: () => sphere(0.07, 6)
};

// Ступени прозрачности. Материал общий для всех частиц одного цвета, поэтому «затухание» — это
// переключение между несколькими заранее созданными материалами, а не правка opacity на месте:
// правка немедленно применилась бы ко всем частицам этого цвета сразу.
const FADE_STEPS = 5;

export class TrailSystem {
  /**
   * @param {THREE.Object3D} scene куда добавлять частицы (мировое пространство, не персонаж)
   * @param {object} item предмет каталога слота trail
   */
  constructor(scene, item, { detail = 'full' } = {}) {
    this.scene = scene;
    this.item = item || null;
    this.render = item?.render || {};
    this.kind = this.render.kind || 'particle-trail';
    this.geometry = (SHAPES[this.render.shape] || SHAPES.spark)();
    this.primary = this.render.primary ?? 0xffffff;
    this.secondary = this.render.secondary ?? this.primary;
    this.density = Number(this.render.density) || 1;

    this.live = [];
    this.pool = [];
    this.spawnTimer = 0;
    this.max = BUDGET.full;
    this.detail = 'full';
    this.disposed = false;
    // Векторы переиспользуются: точка появления и смещение считаются каждый кадр, и создавать
    // под них объекты означало бы кормить сборщик мусора шестнадцатью аллокациями за кадр.
    this._spawn = new THREE.Vector3();
    this.setDetail(detail);
  }

  material(step) {
    const color = step % 2 === 0 ? this.primary : this.secondary;
    return basicMaterial(color, (step + 1) / FADE_STEPS);
  }

  setDetail(level) {
    const mode = level === 'minimal' ? 'minimal' : level === 'simple' ? 'reduced' : 'full';
    if (this.detail === mode) return;
    this.detail = mode;
    this.max = Math.max(0, Math.round(BUDGET[mode] * this.density));
    while (this.live.length > this.max) this.recycle(this.live.pop());
  }

  acquire() {
    const item = this.pool.pop();
    if (item) {
      item.mesh.visible = true;
      return item;
    }
    const mesh = new THREE.Mesh(this.geometry, this.material(FADE_STEPS - 1));
    mesh.matrixAutoUpdate = true;
    return { mesh, life: 0, maxLife: 1, spin: 0, rise: 0 };
  }

  recycle(particle) {
    if (!particle) return;
    particle.mesh.visible = false;
    this.scene.remove(particle.mesh);
    this.pool.push(particle);
  }

  /**
   * Точка появления и параметры берутся из состояния владельца. Ничего случайного, кроме лёгкого
   * разброса позиции: он детерминирован фазой, а не Math.random, чтобы след не мерцал.
   */
  emit(position, { speed = 0, grounded = true, phase = 0 } = {}) {
    if (this.disposed || this.max === 0) return;
    const particle = this.live.length >= this.max ? this.live.shift() : this.acquire();
    if (!particle) return;
    particle.life = 0;
    particle.maxLife = this.kind === 'jet-trail' ? 0.36 : 0.62;
    particle.spin = this.render.shape === 'coin' ? 5.5 : 1.2;
    particle.rise = this.render.shape === 'bubble' ? 0.9 : grounded ? 0.25 : -0.4;

    const jitter = Math.sin(phase * 3.7) * 0.16;
    particle.mesh.position.set(position.x + jitter, position.y + Math.cos(phase * 2.9) * 0.08, position.z);
    const scale = this.kind === 'jet-trail' ? 0.7 + Math.min(1, speed / 9) * 0.9 : 1;
    particle.mesh.scale.setScalar(scale);
    particle.mesh.material = this.material(FADE_STEPS - 1);
    this.scene.add(particle.mesh);
    this.live.push(particle);
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} position позиция владельца
   * @param {{speed:number, grounded:boolean, diving:boolean, phase:number}} motion
   */
  update(dt, position, motion = {}) {
    if (this.disposed) return;
    const speed = Number(motion.speed) || 0;
    const grounded = motion.grounded !== false;

    // Ракетный выхлоп усиливается на скорости и в воздухе — ровно то, ради чего он и нужен.
    const intensity =
      this.kind === 'jet-trail'
        ? Math.min(1, speed / 6) * (grounded ? 0.75 : 1.35)
        : Math.min(1, speed / 5.5);
    const rate = this.max === 0 ? 0 : intensity * (this.kind === 'jet-trail' ? 26 : 14);

    if (rate > 0.01) {
      this.spawnTimer += dt * rate;
      // Не больше двух частиц за кадр: при просадке кадра накопленный таймер иначе выплюнул бы
      // весь бюджет разом, и след стал бы кляксой ровно в тот момент, когда стало тяжело.
      let budget = 2;
      while (this.spawnTimer >= 1 && budget-- > 0) {
        this.spawnTimer -= 1;
        this._spawn.copy(position);
        this._spawn.y += this.kind === 'jet-trail' ? 0.5 : 0.28;
        this.emit(this._spawn, { speed, grounded, phase: Number(motion.phase) || 0 });
      }
      if (this.spawnTimer > 2) this.spawnTimer = 0;
    }

    for (let index = this.live.length - 1; index >= 0; index--) {
      const particle = this.live[index];
      particle.life += dt;
      const t = particle.life / particle.maxLife;
      if (t >= 1) {
        this.live.splice(index, 1);
        this.recycle(particle);
        continue;
      }
      particle.mesh.position.y += particle.rise * dt;
      particle.mesh.rotation.z += particle.spin * dt;
      const step = Math.max(0, Math.min(FADE_STEPS - 1, Math.floor((1 - t) * FADE_STEPS)));
      particle.mesh.material = this.material(step);
      particle.mesh.scale.multiplyScalar(1 - dt * 0.55);
    }
  }

  clear() {
    while (this.live.length) this.recycle(this.live.pop());
  }

  dispose() {
    this.disposed = true;
    this.clear();
    for (const particle of this.pool) this.scene.remove(particle.mesh);
    this.pool.length = 0;
  }

  get liveCount() {
    return this.live.length;
  }
}

// Цифровые призраки — отдельный след: он не сыплет частицы, а оставляет один-два упрощённых
// силуэта. Полную копию Character клонировать нельзя: это десятки мешей на каждый кадр.
export class GhostTrail {
  constructor(scene, item, { detail = 'full' } = {}) {
    this.scene = scene;
    this.render = item?.render || {};
    this.count = Math.max(1, Math.min(2, this.render.ghosts || 2));
    this.interval = 0.22;
    this.timer = 0;
    this.disposed = false;
    this.detail = 'full';

    this.ghosts = [];
    for (let index = 0; index < this.count; index++) {
      const mesh = new THREE.Mesh(
        // Силуэт, а не персонаж: одна капсула нужного размера читается как «он был здесь».
        new THREE.CapsuleGeometry(0.46, 0.72, 3, 8),
        new THREE.MeshBasicMaterial({
          color: index % 2 === 0 ? (this.render.primary ?? 0x7fe7ff) : (this.render.secondary ?? 0xff4fd8),
          transparent: true,
          opacity: 0.32,
          depthWrite: false
        })
      );
      mesh.visible = false;
      this.ghosts.push({ mesh, life: 0 });
    }
    this.setDetail(detail);
  }

  setDetail(level) {
    this.detail = level;
    this.active = level !== 'minimal';
    if (!this.active) this.clear();
  }

  update(dt, position, motion = {}) {
    if (this.disposed || !this.active) return;
    const speed = Number(motion.speed) || 0;
    this.timer -= dt;
    if (speed > 2.5 && this.timer <= 0) {
      this.timer = this.interval * (this.detail === 'simple' ? 1.8 : 1);
      const ghost = this.ghosts.reduce((oldest, item) => (item.life > oldest.life ? item : oldest));
      ghost.life = 0;
      ghost.mesh.position.copy(position);
      ghost.mesh.position.y += 0.82;
      ghost.mesh.rotation.y = Number(motion.rotationY) || 0;
      ghost.mesh.visible = true;
      this.scene.add(ghost.mesh);
    }
    for (const ghost of this.ghosts) {
      if (!ghost.mesh.visible) continue;
      ghost.life += dt;
      const t = ghost.life / 0.5;
      if (t >= 1) {
        ghost.mesh.visible = false;
        this.scene.remove(ghost.mesh);
        continue;
      }
      ghost.mesh.material.opacity = 0.32 * (1 - t);
      ghost.mesh.scale.setScalar(1 - t * 0.18);
    }
  }

  clear() {
    for (const ghost of this.ghosts) {
      ghost.mesh.visible = false;
      this.scene.remove(ghost.mesh);
    }
  }

  dispose() {
    this.disposed = true;
    this.clear();
    for (const ghost of this.ghosts) {
      ghost.mesh.geometry.dispose();
      ghost.mesh.material.dispose();
    }
    this.ghosts.length = 0;
  }

  get liveCount() {
    return this.ghosts.filter(ghost => ghost.mesh.visible).length;
  }
}

export function createTrail(scene, item, options) {
  if (!item) return null;
  if (item.render?.kind === 'ghost-trail') return new GhostTrail(scene, item, options);
  return new TrailSystem(scene, item, options);
}
