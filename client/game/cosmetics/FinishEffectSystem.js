import * as THREE from 'three';
import { basicMaterial, box, cone, glowMaterial, sphere, torus } from './CosmeticResources.js';

// Победная презентация.
//
// Ключевое ограничение: эффект НЕ объявляет победу. Он запускается уже после того, как сервер
// подтвердил финиш и результат, и не трогает ни позицию, ни состояние забега — только рисует.
// Поэтому здесь нет ни одного обращения к сессии, счёту или сети.
//
// Второе ограничение — уборка. Реванш, возврат в лобби и уход игрока происходят посреди эффекта
// заведомо чаще, чем «эффект успел доиграть»: cancel() обязан приводить сцену в исходное состояние
// из любой точки анимации.

const DURATION_BOUNDS = Object.freeze({ min: 1.5, max: 3.5 });

export class FinishEffectSystem {
  /**
   * @param {THREE.Object3D} scene сцена, в которую добавляется эффект
   */
  constructor(scene) {
    this.scene = scene;
    this.group = null;
    this.item = null;
    this.time = 0;
    this.duration = 0;
    this.parts = [];
    this.owned = [];
    this.remote = false;
  }

  get active() {
    return Boolean(this.group);
  }

  /**
   * @param {object} item предмет каталога слота finish
   * @param {THREE.Vector3} position где играть
   * @param {{remote?: boolean, detail?: string}} options удалённая версия упрощается
   */
  play(item, position, { remote = false, detail = 'full' } = {}) {
    if (!item || detail === 'minimal') return false;
    this.cancel();
    this.item = item;
    this.remote = remote;
    this.duration = Math.min(
      DURATION_BOUNDS.max,
      Math.max(DURATION_BOUNDS.min, Number(item.render?.duration) || 2.2)
    );
    this.time = 0;
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.parts = [];

    const render = item.render || {};
    const simple = remote || detail !== 'full';
    switch (render.kind) {
      case 'finish-portal':
        this.buildPortal(render, simple);
        break;
      case 'finish-burst':
        this.buildBurst(render, simple);
        break;
      case 'finish-cannon':
        this.buildCannon(render, simple);
        break;
      default:
        // `finish-glyph` — унаследованный вариант: его показывает интерфейс символом на карточке
        // результата, отдельной сцены он не требует и не требовал.
        this.group = null;
        this.item = null;
        return false;
    }
    this.scene.add(this.group);
    return true;
  }

  add(mesh, role, own = true) {
    this.group.add(mesh);
    this.parts.push({ mesh, role, baseY: mesh.position.y });
    if (own) this.owned.push(mesh);
    return mesh;
  }

  buildPortal(render, simple) {
    const ring = new THREE.Mesh(
      torus(0.9, 0.1, 20),
      glowMaterial(render.primary ?? 0x8f6bff, { intensity: 1.4 })
    );
    ring.position.y = 1;
    this.add(ring, 'ring', false);
    const disc = new THREE.Mesh(
      sphere(0.8, 14),
      new THREE.MeshBasicMaterial({
        color: render.secondary ?? 0x6cf7ff,
        transparent: true,
        opacity: 0.55,
        depthWrite: false
      })
    );
    disc.position.y = 1;
    disc.scale.set(1, 1, 0.12);
    this.add(disc, 'disc');
    if (simple) return;
    for (let index = 0; index < 6; index++) {
      const spark = new THREE.Mesh(box(0.09, 0.09, 0.09), basicMaterial(render.primary ?? 0x8f6bff, 0.8));
      spark.userData.angle = (index / 6) * Math.PI * 2;
      this.add(spark, 'orbit', false);
    }
  }

  buildBurst(render, simple) {
    const count = simple ? 8 : 18;
    const colors = [render.primary ?? 0xffffff, render.secondary ?? 0xffb547];
    for (let index = 0; index < count; index++) {
      const piece = new THREE.Mesh(box(0.11, 0.11, 0.03), basicMaterial(colors[index % colors.length], 0.95));
      const angle = (index / count) * Math.PI * 2;
      piece.userData.angle = angle;
      piece.userData.speed = 2.6 + (index % 4) * 0.55;
      piece.position.y = 1.1;
      this.add(piece, 'confetti', false);
    }
    if (render.style === 'reveal') {
      const dome = new THREE.Mesh(
        sphere(0.62, 14),
        glowMaterial(render.primary ?? 0xf7d94b, { intensity: 0.8 })
      );
      dome.position.y = 1.15;
      dome.scale.set(1, 0.7, 1);
      this.add(dome, 'lid', false);
    }
    if (render.style === 'arcade') {
      const frame = new THREE.Mesh(
        torus(0.75, 0.055, 18),
        glowMaterial(render.secondary ?? 0x22e0ff, { intensity: 1.3 })
      );
      frame.position.y = 1.4;
      this.add(frame, 'ring', false);
    }
  }

  buildCannon(render, simple) {
    const barrel = new THREE.Mesh(
      cone(0.26, 0.7, 10),
      glowMaterial(render.primary ?? 0x3a3f52, { intensity: 0.2 })
    );
    barrel.position.set(0, 1.1, 0.5);
    barrel.rotation.x = -Math.PI / 2.4;
    this.add(barrel, 'barrel', false);
    const flash = new THREE.Mesh(sphere(0.4, 10), basicMaterial(render.secondary ?? 0xffb547, 0.9));
    flash.position.set(0, 1.35, -0.15);
    this.add(flash, 'flash', false);
    const smokeCount = simple ? 3 : 7;
    for (let index = 0; index < smokeCount; index++) {
      const puff = new THREE.Mesh(sphere(0.22, 8), basicMaterial(0xd8dde8, 0.55));
      puff.userData.angle = (index / smokeCount) * Math.PI * 2;
      puff.position.y = 1.2;
      this.add(puff, 'smoke', false);
    }
  }

  update(dt) {
    if (!this.group) return;
    this.time += dt;
    const t = this.time / this.duration;
    if (t >= 1) {
      this.cancel();
      return;
    }
    const fade = 1 - t;
    for (const part of this.parts) {
      switch (part.role) {
        case 'ring':
          part.mesh.rotation.z += dt * 1.4;
          part.mesh.scale.setScalar(0.4 + Math.sin(Math.min(1, t * 2) * Math.PI * 0.5) * 0.8);
          break;
        case 'disc':
          part.mesh.rotation.z -= dt * 0.9;
          part.mesh.material.opacity = 0.55 * fade;
          break;
        case 'orbit': {
          const angle = part.mesh.userData.angle + this.time * 3;
          part.mesh.position.set(Math.cos(angle) * 0.9, 1 + Math.sin(angle * 2) * 0.2, Math.sin(angle) * 0.2);
          break;
        }
        case 'confetti': {
          const angle = part.mesh.userData.angle;
          const speed = part.mesh.userData.speed;
          part.mesh.position.set(
            Math.cos(angle) * speed * this.time * 0.5,
            1.1 + this.time * 2.2 - this.time * this.time * 3.4,
            Math.sin(angle) * speed * this.time * 0.5
          );
          part.mesh.rotation.x += dt * 6;
          part.mesh.rotation.y += dt * 4;
          break;
        }
        case 'lid':
          part.mesh.position.y = part.baseY + Math.min(1, t * 2.5) * 1.4;
          part.mesh.rotation.z += dt * 2.2;
          break;
        case 'flash':
          part.mesh.scale.setScalar(Math.max(0.05, 1.6 * (1 - Math.min(1, t * 4))));
          part.mesh.visible = t < 0.25;
          break;
        case 'smoke': {
          const angle = part.mesh.userData.angle;
          part.mesh.position.set(
            Math.cos(angle) * this.time * 1.1,
            1.2 + this.time * 0.8,
            Math.sin(angle) * this.time * 1.1 - 0.2
          );
          part.mesh.scale.setScalar(0.5 + this.time * 0.9);
          part.mesh.material.opacity = 0.55 * fade;
          break;
        }
        default:
          break;
      }
    }
  }

  /** Досрочная остановка: реванш, возврат в лобби, смена сцены, уход игрока. */
  cancel() {
    if (!this.group) return;
    this.scene.remove(this.group);
    // Собственные материалы (у них своя прозрачность и они не из общего кэша) освобождаются здесь.
    // Всё, что взято из кэша, освобождать нельзя: им пользуются другие персонажи.
    for (const mesh of this.owned) mesh.material.dispose();
    this.owned.length = 0;
    this.parts.length = 0;
    this.group = null;
    this.item = null;
    this.time = 0;
  }

  dispose() {
    this.cancel();
  }
}
