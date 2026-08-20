import * as THREE from 'three';
import { supportIndexAt, supportTop } from '/shared/courseCollision.js';
import { COLORS } from '../core/Config.js';
import { PLAYER_BODY_RADIUS, PLAYER_FOOT } from './PlayerDimensions.js';

// Общая основа для всех уровней.
//
// Уровней в игре два вида: процедурные трассы гонки (Course) и рукотворные кооперативные главы
// (CoopCourse). Геометрия у них разная, но всё, что под ней, одинаково: кэш материалов, фабрики
// примитивов, поиск опоры под ногами и освобождение ресурсов. Раньше это существовало только внутри
// Course, и кооперативным главам пришлось бы завести вторую копию коллизий — то есть два места,
// где физика могла бы разъехаться.

export { PLAYER_FOOT } from './PlayerDimensions.js';

// Игрок, стоящий на неподвижной опоре, не получает переноса. Вектор общий и только читается —
// иначе каждый шаг физики на статичной платформе выделял бы новый Vector3.
const ZERO_DELTA = Object.freeze(new THREE.Vector3());

export class CourseBuilder {
  constructor(scene, { quality = 'high' } = {}) {
    this.scene = scene;
    this.quality = quality;
    this.group = new THREE.Group();
    this.scene.add(this.group);

    // Опоры, на которые можно встать.
    this.platforms = [];
    // Плоское описание тех же опор для общей проверки пола. Живёт ровно столько же, сколько
    // platforms, и обновляется на месте — см. syncColliders().
    this.colliders = [];
    // Препятствия, реагирующие на касание.
    this.obstacles = [];
    // Платформы с собственным движением: их сдвиг за шаг переносит стоящего игрока.
    this.dynamic = [];
    // Меши, перекрывающие обзор: по ним камера решает, насколько подъехать ближе.
    this.cameraMeshes = [];
    // Только явно помеченные стены участвуют в wall-bounce. Обычная декорация и борта трассы
    // никогда не меняют движение, поэтому приём остаётся читаемым и не удивляет новичка.
    this.skillWalls = [];
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
    opacity = 1,
    wallBounce = false
  } = {}) {
    const geometry = bevel ? new THREE.BoxGeometry(w, h, d, 2, 1, 2) : new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geometry, this.material({ color, emissive, emissiveIntensity, opacity }));
    mesh.position.set(x, y, z);
    mesh.castShadow = this.quality !== 'low';
    mesh.receiveShadow = true;
    this.group.add(mesh);
    if (wallBounce) this.skillWalls.push({ mesh, w, h, d });
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
  // Сама проверка живёт в shared/courseCollision.js: это чистая арифметика над коробками и
  // цилиндрами, и серверная симуляция обязана спрашивать про пол по той же формуле. Здесь остаётся
  // только перенос текущих позиций мешей в плоское описание опор — по одному объекту на платформу,
  // созданному один раз, чтобы физический шаг ничего не выделял.
  surfaceAt(position, previousY, velocityY) {
    const colliders = this.syncColliders();
    const index = supportIndexAt(colliders, position, previousY, velocityY, PLAYER_FOOT);
    if (index < 0) return null;
    const platform = this.platforms[index];
    return { y: supportTop(colliders[index]), platform, delta: platform.delta || ZERO_DELTA };
  }

  // Плоское описание опор, отражающее текущее положение мешей.
  syncColliders() {
    const colliders = this.colliders;
    colliders.length = this.platforms.length;
    for (let index = 0; index < this.platforms.length; index++) {
      const platform = this.platforms[index];
      const meshPosition = platform.mesh.position;
      let collider = colliders[index];
      if (!collider) {
        collider = { x: 0, y: 0, z: 0, w: 0, h: 0, d: 0, r: 0, type: 'box', disabled: false };
        colliders[index] = collider;
      }
      collider.x = meshPosition.x;
      collider.y = meshPosition.y;
      collider.z = meshPosition.z;
      collider.w = platform.w;
      collider.h = platform.h;
      collider.d = platform.d;
      collider.r = platform.r || 0;
      collider.type = platform.type;
      collider.disabled = platform.disabled === true;
    }
    return colliders;
  }

  // Возвращает нормаль специальной стены, пересечённой за текущий физический шаг.
  wallBounceAt(position, previous, velocity) {
    for (const wall of this.skillWalls) {
      const m = wall.mesh;
      if (Math.abs(position.y - m.position.y) > wall.h / 2 + 0.45) continue;
      const withinX = Math.abs(position.x - m.position.x) <= wall.w / 2 + PLAYER_BODY_RADIUS;
      const withinZ = Math.abs(position.z - m.position.z) <= wall.d / 2 + PLAYER_BODY_RADIUS;
      if (!withinX || !withinZ) continue;

      if (wall.w < wall.d) {
        const side = Math.sign(previous.x - m.position.x) || -Math.sign(velocity.x) || 1;
        if (velocity.x * side < -1.5) return { x: side, z: 0 };
      } else {
        const side = Math.sign(previous.z - m.position.z) || -Math.sign(velocity.z) || 1;
        if (velocity.z * side < -1.5) return { x: 0, z: side };
      }
    }
    return null;
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
    this.colliders.length = 0;
    this.obstacles.length = 0;
    this.dynamic.length = 0;
    this.cameraMeshes.length = 0;
    this.skillWalls.length = 0;
  }
}
