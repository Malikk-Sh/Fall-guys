import * as THREE from 'three';

// Вторичное движение аксессуаров.
//
// Это presentation, а не физика. Аксессуар не имеет массы, не сталкивается, не влияет ни на один
// расчёт игры — он лишь отстаёт от движения владельца и качается по затуханию. Разница
// принципиальная: игровая физика идёт фиксированным шагом и обязана совпадать у всех клиентов,
// а здесь допустимы кадровая частота и локальные вольности, потому что от них ничего не зависит.
//
// Отсюда же запрет на случайность в кадре: колебание считается от накопленной фазы, а не от
// Math.random(). Дрожащий каждый кадр по-новому аксессуар выглядит поломкой, а не жизнью.

const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value);

// Роли, которые аниматор умеет двигать. Часть, помеченная неизвестной ролью, просто стоит на месте.
const ROLES = new Set([
  'swing',
  'spike',
  'ear',
  'tail',
  'tentacle',
  'perch',
  'pulse',
  'scan',
  'swirl',
  'blink',
  'glitch',
  'orbit',
  'orbit-ring',
  'ripple',
  'lid',
  'toast'
]);

export class AccessoryAnimator {
  /**
   * @param {THREE.Object3D} root корень аксессуара
   * @param {object} motion параметры из каталога: sway, bob, lag, landing, pop
   * @param {number} seed сдвиг фазы, чтобы одинаковые предметы у разных игроков не качались в такт
   */
  constructor(root, motion = {}, seed = 0) {
    this.root = root;
    this.sway = Number(motion.sway) || 0;
    this.bob = Number(motion.bob) || 0;
    this.lag = Number(motion.lag) || 0;
    this.landingScale = Number(motion.landing) || 0;
    this.pop = Number(motion.pop) || 0;

    this.phase = seed;
    this.lagAngle = 0;
    this.lagVelocity = 0;
    this.landImpulse = 0;
    this.popTimer = 0;
    this.airBlend = 0;

    // Части собираются один раз при создании. Обход иерархии каждый кадр на шестнадцать
    // персонажей — ровно та трата, ради которой всё остальное и оптимизируется.
    this.parts = [];
    root.traverse(object => {
      const role = object.userData?.cosmeticRole;
      if (!role || !ROLES.has(role)) return;
      this.parts.push({
        role,
        object,
        restY: object.userData.restY ?? object.position.y,
        restX: object.position.x,
        baseScale: object.scale.x,
        offset: this.parts.length * 0.7
      });
    });
    this.active = this.parts.length > 0 || this.sway > 0 || this.bob > 0 || this.lag > 0;
  }

  landed(strength = 1) {
    this.landImpulse = Math.min(1.4, this.landImpulse + clamp01(strength) * (this.landingScale || 1));
    if (this.pop > 0 && strength > 0.5) this.popTimer = 1;
  }

  /**
   * @param {number} dt секунды
   * @param {{speed:number, grounded:boolean, vertical:number, diving:boolean, state:string}} motion
   */
  update(dt, motion) {
    if (!this.active) return;
    const speed = Number(motion?.speed) || 0;
    const run = clamp01(speed / 7);
    const grounded = motion?.grounded !== false;
    this.airBlend = THREE.MathUtils.damp(this.airBlend, grounded ? 0 : 1, 6, dt);
    this.phase += dt * (2.4 + run * 5.5);

    // Отставание от разгона. Пружина второго порядка с сильным затуханием: аксессуар качнётся
    // назад на ускорении и вернётся, не начав раскачиваться сам по себе.
    if (this.lag > 0) {
      const target = -run * 0.34 - this.airBlend * 0.18;
      this.lagVelocity += (target - this.lagAngle) * 34 * dt;
      this.lagVelocity *= Math.exp(-9 * dt);
      this.lagAngle += this.lagVelocity * dt;
      this.root.rotation.x = this.lagAngle * this.lag;
    }
    if (this.sway > 0) {
      this.root.rotation.z = Math.sin(this.phase * 0.85) * this.sway * (0.35 + run * 0.65);
    }

    this.landImpulse = Math.max(0, this.landImpulse - dt * 3.2);
    this.popTimer = Math.max(0, this.popTimer - dt * 1.8);
    const bounce = Math.sin(this.landImpulse * Math.PI) * 0.09 * (this.bob || 1);

    for (const part of this.parts) {
      const wave = Math.sin(this.phase + part.offset);
      switch (part.role) {
        case 'swing':
        case 'perch':
          part.object.rotation.z = wave * 0.18 * (0.4 + run);
          part.object.position.y = part.restY + bounce * 0.6;
          break;
        case 'spike':
        case 'ear':
        case 'tentacle':
          part.object.rotation.x = wave * 0.16 * (0.3 + run) - this.airBlend * 0.12;
          break;
        case 'tail':
          part.object.rotation.y = wave * 0.3 * (0.25 + run);
          break;
        case 'pulse': {
          const scale = part.baseScale * (1 + Math.sin(this.phase * 1.6 + part.offset) * 0.06);
          part.object.scale.set(scale, scale, part.object.scale.z);
          break;
        }
        case 'scan':
          // Строка развёртки ползёт сверху вниз и перескакивает обратно. Детерминированная пила,
          // без случайности: мигающее лицо каждый кадр по-новому читается как дефект.
          part.object.position.y = part.restY + 0.09 - ((this.phase * 0.16) % 1) * 0.18;
          break;
        case 'swirl':
          part.object.rotation.z += dt * 0.9;
          break;
        case 'blink': {
          const on = Math.sin(this.phase * 1.1) > 0.6;
          part.object.visible = on;
          break;
        }
        case 'glitch': {
          // Сдвиг происходит редко и мгновенно: пороговое условие вместо непрерывного шума.
          const burst = Math.sin(this.phase * 2.3 + part.offset) > 0.93;
          part.object.position.x = part.restX + (burst ? (part.restX > 0 ? 0.05 : -0.05) : 0);
          part.object.visible = burst || Math.sin(this.phase * 0.7) > -0.2;
          break;
        }
        case 'orbit': {
          const angle = this.phase * 0.6 + (part.object.userData.orbitPhase || 0);
          const radius = part.object.userData.orbitRadius || 0.6;
          part.object.position.set(
            Math.cos(angle) * radius,
            (part.object.userData.orbitHeight || 0.9) + Math.sin(angle * 2) * 0.06,
            Math.sin(angle) * radius
          );
          break;
        }
        case 'orbit-ring':
          part.object.rotation.z += dt * 0.35;
          break;
        case 'ripple': {
          const grow = clamp01(this.landImpulse);
          const scale = 1 + grow * 0.9;
          part.object.scale.set(scale, scale, 1);
          part.object.visible = grow > 0.02;
          break;
        }
        case 'lid':
          part.object.rotation.x = -this.landImpulse * 0.5;
          break;
        case 'toast':
          part.object.position.y = part.restY + Math.sin(this.popTimer * Math.PI) * 0.26 * this.pop;
          break;
        default:
          break;
      }
    }
  }

  // Возврат в покой. Нужен при смене детализации и при паузе: замороженный в перекошенной позе
  // аксессуар выглядит хуже, чем прямой.
  reset() {
    this.lagAngle = 0;
    this.lagVelocity = 0;
    this.landImpulse = 0;
    this.popTimer = 0;
    this.root.rotation.set(0, 0, 0);
    for (const part of this.parts) {
      part.object.rotation.set(0, 0, 0);
      part.object.position.y = part.restY;
      part.object.position.x = part.restX;
      part.object.visible = true;
    }
  }
}
