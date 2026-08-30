import * as THREE from 'three';

// Частицы: вспышки при прыжках, приземлениях, ударах и на чекпоинтах.
//
// Меши переиспользуются из пула — создавать по десятку объектов на каждый удар слишком дорого.
// Семантические профили ниже меняют только разлёт уже существующих частиц: это presentation-only
// слой, который не знает ни о физике игрока, ни о коллизиях препятствий.
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
const TAU = Math.PI * 2;

function radialVelocity(velocity, horizontalMin, horizontalMax, verticalMin, verticalMax, power = 1) {
  const angle = Math.random() * TAU;
  const horizontal = horizontalMin + Math.random() * (horizontalMax - horizontalMin);
  velocity.set(
    Math.cos(angle) * horizontal * power,
    (verticalMin + Math.random() * (verticalMax - verticalMin)) * power,
    Math.sin(angle) * horizontal * power
  );
}

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

  profileCount(highCount) {
    return this.quality === 'low' ? Math.max(1, Math.ceil(highCount * 0.72)) : highCount;
  }

  emit(position, color, count, profile = 'burst', power = 1) {
    const total = Math.min(count, this.max - this.items.length);
    for (let i = 0; i < total; i++) {
      const mesh = this.pool.pop() || new THREE.Mesh(this.geometry, this.material(color, OPACITY_STEPS - 1));
      const velocity = mesh.userData.velocity || new THREE.Vector3();
      mesh.material = this.material(color, OPACITY_STEPS - 1);
      mesh.visible = true;
      mesh.position.copy(position);
      mesh.userData.color = color;
      mesh.userData.profile = profile;
      mesh.userData.velocity = velocity;

      if (profile === 'spring') {
        radialVelocity(velocity, 0.65, 1.65, 4.4, 7, power);
        mesh.scale.setScalar(0.58 + Math.random() * 0.48);
        mesh.userData.life = 0.46 + Math.random() * 0.24;
      } else if (profile === 'bumper') {
        radialVelocity(velocity, 3.5, 5.8, 1.1, 3.25, power);
        mesh.scale.setScalar(0.72 + Math.random() * 0.62);
        mesh.userData.life = 0.44 + Math.random() * 0.24;
      } else if (profile === 'spinner') {
        radialVelocity(velocity, 4.1, 6.2, 0.3, 1.2, power);
        mesh.scale.setScalar(0.58 + Math.random() * 0.42);
        mesh.userData.life = 0.34 + Math.random() * 0.2;
      } else if (profile === 'puncher') {
        radialVelocity(velocity, 4.5, 6.8, 1.4, 3.5, power);
        mesh.scale.setScalar(0.78 + Math.random() * 0.62);
        mesh.userData.life = 0.5 + Math.random() * 0.26;
      } else if (profile === 'checkpoint') {
        radialVelocity(velocity, 0.9, 2.3, 5.2, 8.2, power);
        mesh.scale.setScalar(0.62 + Math.random() * 0.5);
        mesh.userData.life = 0.62 + Math.random() * 0.28;
      } else if (profile === 'finish') {
        radialVelocity(velocity, 2.6, 5.4, 4.1, 8.4, power);
        mesh.scale.setScalar(0.72 + Math.random() * 0.72);
        mesh.userData.life = 0.72 + Math.random() * 0.34;
      } else {
        velocity
          .set((Math.random() - 0.5) * 4.8, 1.2 + Math.random() * 3.7, (Math.random() - 0.5) * 4.8)
          .multiplyScalar(power);
        mesh.scale.setScalar(0.7 + Math.random() * 0.7);
        mesh.userData.life = 0.48 + Math.random() * 0.32;
      }

      mesh.userData.maxLife = mesh.userData.life;
      this.scene.add(mesh);
      this.items.push(mesh);
    }
  }

  burst(position, color = 0xffffff, count = 10, power = 1) {
    this.emit(position, color, count, 'burst', power);
  }

  spring(position, color = 0xffd94b) {
    this.emit(position, color, this.profileCount(14), 'spring');
  }

  bumper(position, color = 0xff5a9e) {
    this.emit(position, color, this.profileCount(16), 'bumper');
  }

  spinner(position, color = 0xffd94b) {
    this.emit(position, color, this.profileCount(12), 'spinner');
  }

  puncher(position, color = 0xff5a9e) {
    this.emit(position, color, this.profileCount(12), 'puncher');
  }

  checkpoint(position, color = 0x78f0bc) {
    this.emit(position, color, this.profileCount(22), 'checkpoint');
  }

  finish(position, color = 0xffd94b) {
    this.emit(position, color, this.profileCount(34), 'finish');
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
