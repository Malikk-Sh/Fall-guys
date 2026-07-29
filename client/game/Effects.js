import * as THREE from 'three';

// Частицы: вспышки при прыжках, приземлениях, ударах и на чекпоинтах.
//
// Меши переиспользуются из пула — создавать по десятку объектов на каждый удар слишком дорого.
//
// Про затухание. Материалы общие для всех частиц одного цвета, поэтому задать прозрачность
// отдельной частице через material.opacity нельзя: правка немедленно применится ко всем частицам
// этого цвета. Раньше именно так и было, и вместо плавного угасания все частицы одного цвета
// мигали вместе, принимая прозрачность той, что обновилась последней.
//
// Решение — набор материалов на несколько ступеней прозрачности. Частица по мере угасания
// переключается на всё более прозрачный материал. Ступеней достаточно шести: разница между
// соседними на глаз не различима, а материалов остаётся считанные единицы.
const OPACITY_STEPS = 6;

export class Effects {
  constructor(scene, quality = 'high') {
    this.scene = scene;
    this.items = [];
    this.pool = [];
    this.geometry = new THREE.IcosahedronGeometry(0.085, 0);
    this.materials = new Map();
    this.setQuality(quality);
  }

  // Лимит частиц зависит от качества. Раньше он фиксировался при запуске и не менялся при
  // переключении качества — эффект от переключения появлялся только после перезагрузки страницы.
  setQuality(quality) {
    this.quality = quality;
    this.max = quality === 'low' ? 34 : 96;
    while (this.items.length > this.max) {
      const mesh = this.items.pop();
      this.scene.remove(mesh);
      this.pool.push(mesh);
    }
  }

  material(color, step) {
    const key = `${color}|${step}`;
    let cached = this.materials.get(key);
    if (!cached) {
      cached = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: (step + 1) / OPACITY_STEPS,
        depthWrite: false
      });
      this.materials.set(key, cached);
    }
    return cached;
  }

  burst(position, color = 0xffffff, count = 10, power = 1) {
    const total = Math.min(count, this.max - this.items.length);
    for (let i = 0; i < total; i++) {
      const mesh = this.pool.pop() || new THREE.Mesh(this.geometry, this.material(color, OPACITY_STEPS - 1));
      mesh.material = this.material(color, OPACITY_STEPS - 1);
      mesh.visible = true;
      mesh.position.copy(position);
      mesh.scale.setScalar(0.7 + Math.random() * 0.7);
      mesh.userData.color = color;
      mesh.userData.velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 4.8,
        1.2 + Math.random() * 3.7,
        (Math.random() - 0.5) * 4.8
      ).multiplyScalar(power);
      mesh.userData.life = 0.48 + Math.random() * 0.32;
      mesh.userData.maxLife = mesh.userData.life;
      this.scene.add(mesh);
      this.items.push(mesh);
    }
  }

  trail(position, color = 0xffd94b) {
    if (this.items.length >= this.max) return;
    this.burst(position, color, 1, 0.35);
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const mesh = this.items[i];
      mesh.userData.life -= dt;
      if (mesh.userData.life <= 0) {
        mesh.visible = false;
        this.scene.remove(mesh);
        this.items.splice(i, 1);
        this.pool.push(mesh);
        continue;
      }
      mesh.position.addScaledVector(mesh.userData.velocity, dt);
      mesh.userData.velocity.y -= 8 * dt;
      mesh.scale.multiplyScalar(0.96);

      const t = mesh.userData.life / mesh.userData.maxLife;
      const step = Math.max(0, Math.min(OPACITY_STEPS - 1, Math.floor(t * OPACITY_STEPS)));
      const wanted = this.material(mesh.userData.color, step);
      if (mesh.material !== wanted) mesh.material = wanted;
    }
  }

  clear() {
    for (const mesh of this.items) this.scene.remove(mesh);
    this.pool.push(...this.items);
    this.items.length = 0;
  }

  dispose() {
    this.clear();
    this.geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
  }
}
