import * as THREE from 'three';
import { supportIndexAt, supportTop } from '/shared/courseCollision.js';
import { wallBounceNormalAt } from '/shared/courseWalls.js';
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

// Единственный способ сдвинуть опору.
//
// Источник истины — плоская запись, меш её повторяет. Раньше было наоборот, и опора существовала
// только там, где есть Three.js: серверная симуляция не могла бы спросить про пол, не построив
// сцену. Двигать меш напрямую теперь нельзя — запись отстанет, и игрок будет стоять на том, чего
// на экране уже нет.
export function movePlatform(platform, axis, value) {
  platform[axis] = value;
  platform.mesh.position[axis] = value;
}

// То же правило для препятствий: сначала запись, потом меш.
export function moveObstacle(obstacle, axis, value) {
  obstacle[axis] = value;
  obstacle.mesh.position[axis] = value;
}

// Опознаётся препятствие своим идентификатором, а не uuid меша.
//
// По этому ключу игрок помнит, когда его последний раз ударило, — то есть на нём держится
// перезарядка удара. Пока ключом был uuid, физика удара не могла существовать без сцены.
let nextObstacleId = 0;

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
    // Стена, как и опора, описана числами: отскок обязан считаться без сцены.
    if (wallBounce) this.skillWalls.push({ mesh, x, y, z, w, h, d });
    if (collider) {
      const platform = {
        mesh,
        x,
        y,
        z,
        w,
        h,
        d,
        r: 0,
        type: 'box',
        disabled: false,
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
        x,
        y,
        z,
        w: r * 1.7,
        h,
        d: r * 1.7,
        r,
        type: 'cylinder',
        disabled: false,
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
  // цилиндрами, и серверная симуляция обязана спрашивать про пол по той же формуле. Платформа сама
  // и есть плоская запись опоры — меш висит на ней дополнительным полем и в проверку не входит.
  surfaceAt(position, previousY, velocityY) {
    const index = supportIndexAt(this.platforms, position, previousY, velocityY, PLAYER_FOOT);
    if (index < 0) return null;
    const platform = this.platforms[index];
    return { y: supportTop(platform), platform, delta: platform.delta || ZERO_DELTA };
  }

  movePlatform(platform, axis, value) {
    movePlatform(platform, axis, value);
  }

  moveObstacle(obstacle, axis, value) {
    moveObstacle(obstacle, axis, value);
  }

  // Балка вертушки. Расстановка знает про неё только то, что у объекта поворачивается rotation.y —
  // сам поворот считается по данным препятствия, а меш его повторяет.
  spinnerBeam({ x = 0, y = 0, z = 0, length = 1, width = 1 } = {}) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(length, 0.48, width),
      this.material({ color: COLORS.yellow, roughness: 0.24 })
    );
    bar.castShadow = true;
    pivot.add(bar);
    this.group.add(pivot);
    return pivot;
  }

  // Кольцо бампера — чистая декорация, в физике не участвует.
  ringDecor({ x = 0, y = 0, z = 0, radius = 1 } = {}) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.095, 6, 16),
      this.material({ color: 0xffffff, roughness: 0.2 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y, z);
    ring.castShadow = true;
    this.group.add(ring);
    return ring;
  }

  registerObstacle(record) {
    const obstacle = { id: `obstacle-${nextObstacleId++}`, ...record };
    this.obstacles.push(obstacle);
    return obstacle;
  }

  // Возвращает нормаль специальной стены, пересечённой за текущий физический шаг.
  wallBounceAt(position, previous, velocity) {
    return wallBounceNormalAt(this.skillWalls, position, previous, velocity, PLAYER_BODY_RADIUS);
  }

  // Сдвиг движущихся платформ за шаг. Игрок, стоящий сверху, получает этот сдвиг в surfaceAt.
  //
  // Ход задаётся данными — ось, центр, размах, скорость и фаза, — поэтому положение любой такой
  // опоры в любой момент считается без сцены и без истории.
  updateDynamic(elapsed) {
    for (const platform of this.dynamic) {
      const motion = platform.motion;
      const previous = platform[motion.axis];
      const value = motion.origin + Math.sin(elapsed * motion.speed + motion.phase) * motion.range;
      this.movePlatform(platform, motion.axis, value);
      platform.delta.set(0, 0, 0);
      platform.delta[motion.axis] = value - previous;
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
    this.skillWalls.length = 0;
  }
}
