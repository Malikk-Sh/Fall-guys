import * as THREE from 'three';
import { COLORS } from '../core/Config.js';

// Общая основа для всех уровней.
//
// Уровней в игре два вида: процедурные трассы гонки (Course) и рукотворные кооперативные главы
// (CoopCourse). Геометрия у них разная, но всё, что под ней, одинаково: кэш материалов, фабрики
// примитивов, поиск опоры под ногами и освобождение ресурсов. Раньше это существовало только внутри
// Course, и кооперативным главам пришлось бы завести вторую копию коллизий — то есть два места,
// где физика могла бы разъехаться.

export const PLAYER_FOOT = 0.48;

export class CourseBuilder {
  constructor(scene, { quality = 'high' } = {}) {
    this.scene = scene;
    this.quality = quality;
    this.group = new THREE.Group();
    this.scene.add(this.group);

    // Опоры, на которые можно встать.
    this.platforms = [];
    // Препятствия, реагирующие на касание.
    this.obstacles = [];
    // Платформы с собственным движением: их сдвиг за шаг переносит стоящего игрока.
    this.dynamic = [];
    // Меши, перекрывающие обзор: по ним камера решает, насколько подъехать ближе.
    this.cameraMeshes = [];
    // Кэш материалов, ключ — сочетание всех визуальных свойств. См. material().
    this.materials = new Map();
  }

  // Материалы кэшируются по всем своим параметрам.
  //
  // Иначе каждый вызов box() и cylinder() создавал бы новый MeshStandardMaterial — на уровень
  // приходились бы сотни материалов при том, что уникальных сочетаний меньше двадцати. Каждый
  // материал это отдельное состояние шейдера и лишнее переключение при отрисовке.
  //
  // Важно: раз материал общий, менять его после создания у конкретного меша нельзя — правка
  // расползётся на все меши с тем же материалом. Поэтому свечение и прозрачность задаются здесь же,
  // параметрами, и входят в ключ кэша.
  material({ color, roughness = 0.3, emissive = null, emissiveIntensity = 1, opacity = 1 } = {}) {
    const key = `${color}|${roughness}|${emissive}|${emissiveIntensity}|${opacity}`;
    let cached = this.materials.get(key);
    if (cached) return cached;
    cached = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness: 0.03,
      transparent: opacity < 1,
      opacity
    });
    if (emissive !== null) {
      cached.emissive = new THREE.Color(emissive);
      cached.emissiveIntensity = emissiveIntensity;
    }
    this.materials.set(key, cached);
    return cached;
  }

  box({
    x = 0,
    y = 0,
    z = 0,
    w = 1,
    h = 1,
    d = 1,
    color = COLORS.purple,
    bevel = false,
    collider = true,
    emissive = null,
    emissiveIntensity = 1,
    opacity = 1
  } = {}) {
    const geometry = bevel ? new THREE.BoxGeometry(w, h, d, 2, 1, 2) : new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geometry, this.material({ color, emissive, emissiveIntensity, opacity }));
    mesh.position.set(x, y, z);
    mesh.castShadow = this.quality !== 'low';
    mesh.receiveShadow = true;
    this.group.add(mesh);
    if (collider) {
      const platform = {
        mesh,
        w,
        h,
        d,
        type: 'box',
        lastPosition: mesh.position.clone(),
        delta: new THREE.Vector3()
      };
      this.platforms.push(platform);
      this.cameraMeshes.push(mesh);
      return platform;
    }
    return { mesh, w, h, d, type: 'decor' };
  }

  cylinder({ x = 0, y = 0, z = 0, r = 1, h = 0.5, color = COLORS.pink, collider = false } = {}) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, h, this.quality === 'low' ? 12 : 20),
      this.material({ color })
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = this.quality !== 'low';
    mesh.receiveShadow = true;
    this.group.add(mesh);
    // Цилиндры тоже должны перекрывать камеру: без этого она проходила сквозь бамперы и пружины.
    this.cameraMeshes.push(mesh);
    if (collider) {
      const platform = {
        mesh,
        w: r * 1.7,
        h,
        d: r * 1.7,
        r,
        type: 'cylinder',
        lastPosition: mesh.position.clone(),
        delta: new THREE.Vector3()
      };
      this.platforms.push(platform);
      return platform;
    }
    return mesh;
  }

  // Поиск опоры под ногами.
  //
  // Это свип-тест, а не проверка пересечения: сравниваются положения ступни до и после шага. Иначе
  // на скорости игрок за один шаг проскакивал бы тонкую платформу насквозь, ни разу не оказавшись
  // внутри неё. Условие velocityY > 2.2 не даёт «приземлиться» на платформу, сквозь которую игрок
  // как раз пролетает вверх — например, выпрыгивая из-под неё.
  surfaceAt(position, previousY, velocityY) {
    let best = null;
    for (const p of this.platforms) {
      if (p.disabled) continue;
      const m = p.mesh;
      const dx = Math.abs(position.x - m.position.x);
      const dz = Math.abs(position.z - m.position.z);
      const inside =
        p.type === 'cylinder'
          ? Math.hypot(position.x - m.position.x, position.z - m.position.z) < p.r - 0.12
          : dx < p.w / 2 - 0.12 && dz < p.d / 2 - 0.12;
      if (!inside) continue;

      const top = m.position.y + p.h / 2;
      const foot = position.y - PLAYER_FOOT;
      const previousFoot = previousY - PLAYER_FOOT;
      if (foot > top + 0.45 || previousFoot < top - 0.48 || velocityY > 2.2) continue;
      if (!best || top > best.y) best = { y: top, platform: p, delta: p.delta || new THREE.Vector3() };
    }
    return best;
  }

  // Сдвиг движущихся платформ за шаг. Игрок, стоящий сверху, получает этот сдвиг в surfaceAt.
  updateDynamic(elapsed) {
    for (const platform of this.dynamic) {
      platform.lastPosition.copy(platform.mesh.position);
      const m = platform.motion;
      const value = m.origin + Math.sin(elapsed * m.speed + m.phase) * m.range;
      platform.mesh.position[m.axis] = value;
      platform.delta.copy(platform.mesh.position).sub(platform.lastPosition);
    }
  }

  dispose() {
    this.scene.remove(this.group);
    // Геометрия у каждого меша своя — освобождаем обходом. Материалы общие, поэтому они лежат в
    // кэше и освобождаются один раз: пройтись по мешам значило бы вызывать dispose на одном и том
    // же материале десятки раз.
    this.group.traverse(o => o.geometry?.dispose?.());
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    this.platforms.length = 0;
    this.obstacles.length = 0;
    this.dynamic.length = 0;
    this.cameraMeshes.length = 0;
  }
}
