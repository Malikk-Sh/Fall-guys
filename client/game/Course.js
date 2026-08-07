import * as THREE from 'three';
import { CourseBuilder, PLAYER_FOOT } from './CourseBuilder.js';
import {
  COLORS,
  DIFFICULTIES,
  FIRST_SEGMENT_CENTER,
  SEGMENT_LENGTH,
  SEGMENT_WIDTH,
  START_PLATFORM,
  courseName,
  courseSpec,
  seededRandom
} from '../core/Config.js';

const palette = [
  COLORS.purple,
  COLORS.orange,
  COLORS.cyan,
  COLORS.pink,
  COLORS.blue,
  COLORS.mint,
  COLORS.yellow
];
export class Course extends CourseBuilder {
  constructor(scene, spec, { quality = 'high' } = {}) {
    super(scene, { quality });
    this.spec = { ...courseSpec(spec.seed, spec.difficulty), ...spec };
    this.group.name = 'procedural-course';
    this.scenery = [];
    this.rng = seededRandom(this.spec.seed);
    this.stageNames = [];
    this.build();
  }
  addRail(x, z, length) {
    this.box({
      x,
      y: 1.25,
      z,
      w: 0.16,
      h: 1.1,
      d: length,
      color: 0xffffff,
      collider: false,
      opacity: 0.48
    });
    const posts = Math.ceil(length / 4);
    for (let i = 0; i <= posts; i++)
      this.box({
        x,
        y: 0.9,
        z: z - length / 2 + i * (length / posts),
        w: 0.22,
        h: 1.3,
        d: 0.22,
        color: 0xffffff,
        collider: false
      });
  }
  build() {
    this.addStart();
    for (let i = 0; i < this.spec.segmentCount; i++)
      this.addSegment(this.spec.segments[i], i, FIRST_SEGMENT_CENTER - i * SEGMENT_LENGTH);
    this.addFinish();
    this.addCheckpointArches();
    this.addScenery();
  }
  addStart() {
    this.box({
      x: 0,
      y: 0,
      z: START_PLATFORM.z,
      w: START_PLATFORM.width,
      h: 1,
      d: START_PLATFORM.depth,
      color: COLORS.purple,
      bevel: true
    });
    for (const x of [-6.4, 6.4]) this.addRail(x, 5, 12);
    this.box({
      x: 0,
      y: 0.515,
      z: -0.8,
      w: 13,
      h: 0.035,
      d: 0.85,
      color: COLORS.yellow,
      collider: false,
      emissive: COLORS.yellow,
      emissiveIntensity: 1.1
    });
    for (let i = 0; i < 6; i++) {
      const pad = this.cylinder({
        x: -4.5 + i * 1.8,
        y: 0.57,
        z: 7.4,
        r: 0.62,
        h: 0.13,
        color: [COLORS.pink, COLORS.cyan, COLORS.yellow][i % 3]
      });
      pad.scale.z = 0.68;
    }
  }
  addSegment(segment, index, z) {
    const { type, variant = 0 } = segment;
    const mirror = variant === 1 ? -1 : 1;
    const color = palette[(index + this.spec.seed) % palette.length],
      // Направление входит множителем в ту же скорость, что и темп: отрицательная скорость
      // разворачивает и вращение вертушек, и качание молотов, и ход подвижных платформ — то есть
      // ровно всё, что от неё зависит, без отдельной ветки на каждый тип препятствия.
      speed =
        DIFFICULTIES[this.spec.difficulty].speed *
        (this.spec.modifier?.obstacleSpeed || 1) *
        (this.spec.modifier?.obstacleDirection || 1);
    this.stageNames.push(
      {
        sweepers: 'ПЛОЩАДЬ ВРАЩЕНИЯ',
        movers: 'НЕБЕСНЫЕ СТУПЕНИ',
        bumpers: 'БУЛЬВАР БАМПЕРОВ',
        bridge: 'УЗКИЙ ПОВОРОТ',
        punchers: 'ПАРАД МОЛОТОВ',
        bounce: 'САД ПРЫЖКОВ',
        crosswind: 'ДОРОГА ВЕТРОВ'
      }[type]
    );
    if (type === 'sweepers') {
      this.box({ x: 0, y: 0, z, w: SEGMENT_WIDTH.sweepers, h: 1, d: 18, color, bevel: true });
      this.addRail(-5.6, z, 16);
      this.addRail(5.6, z, 16);
      for (const [offset, direction] of [
        [4, 1],
        [-4, -1]
      ])
        this.addSpinner(
          0,
          0.95,
          z + offset,
          10.4,
          0.42,
          speed * (1.35 + this.rng() * 0.45) * direction * (variant === 2 ? -1 : 1),
          index * 0.8 + offset
        );
    }
    if (type === 'movers') {
      this.box({ x: 0, y: 0, z: z + 7, w: SEGMENT_WIDTH.movers, h: 1, d: 4, color, bevel: true });
      this.box({ x: 0, y: 0, z: z - 7, w: SEGMENT_WIDTH.movers, h: 1, d: 4, color, bevel: true });
      for (let j = 0; j < 3; j++) {
        const platform = this.box({
          x: variant === 2 ? (j - 1) * 0.55 : 0,
          y: 0.15 + j * 0.12,
          z: z + 3.5 - j * 3.5,
          w: 3.8,
          h: 0.55,
          d: 3,
          color: palette[(index + j + 2) % palette.length],
          bevel: true
        });
        platform.motion = {
          axis: 'x',
          origin: variant === 2 ? (j - 1) * 0.55 : 0,
          range: variant === 2 ? 3.2 : 3.8,
          speed: speed * (0.82 + j * 0.13),
          phase: j * 2.15 + variant * 0.7
        };
        this.dynamic.push(platform);
      }
    }
    if (type === 'bumpers') {
      this.box({ x: 0, y: 0, z, w: SEGMENT_WIDTH.bumpers, h: 1, d: 18, color, bevel: true });
      this.addRail(-5.6, z, 16);
      this.addRail(5.6, z, 16);
      const points = [
        [-3, 5],
        [2.7, 1],
        [-2.6, -3],
        [2.4, -6]
      ].map(([x, oz]) => [x * mirror, oz]);
      if (variant === 2) points[1][0] = 0;
      for (let j = 0; j < points.length; j++)
        this.addBumper(points[j][0], 1.25, z + points[j][1], 0.86, palette[(index + j + 3) % palette.length]);
    }
    if (type === 'bridge') {
      this.box({ x: 0, y: 0, z, w: SEGMENT_WIDTH.bridge, h: 1, d: 18, color, bevel: true });
      this.addRail(-1.55, z, 16);
      this.addRail(1.55, z, 16);
      this.addSpinner(0, 1, z, 7, 0.38, speed * 1.08 * (variant === 1 ? -1 : 1), index * 0.55);
      for (const side of [-1, 1])
        for (let j = -1; j <= 1; j++)
          this.box({
            x: side * 3.4,
            y: -0.25,
            z: z + j * 5.2,
            w: 2.3,
            h: 0.45,
            d: 2.3,
            color: COLORS.cyan,
            collider: false
          }).mesh.rotation.y = j * 0.4;
    }
    if (type === 'punchers') {
      this.box({ x: 0, y: 0, z, w: SEGMENT_WIDTH.punchers, h: 1, d: 18, color, bevel: true });
      this.addRail(-5.1, z, 16);
      this.addRail(5.1, z, 16);
      for (let j = 0; j < 3; j++) {
        const p = this.box({
          x: (j % 2 ? 3.7 : -3.7) * mirror,
          y: 1,
          z: z + 5 - j * 5,
          w: 2.7,
          h: 2.1,
          d: 1.2,
          color: COLORS.pink,
          collider: false
        }).mesh;
        p.scale.z = 0.86;
        const obstacle = {
          type: 'puncher',
          mesh: p,
          originX: p.position.x,
          range: 5.8,
          speed: speed * (1.4 + j * 0.14),
          phase: j * 2.2 + variant * 0.6,
          w: 2.7,
          d: 1.2,
          radius: 1.7
        };
        this.obstacles.push(obstacle);
      }
    }
    if (type === 'bounce') {
      this.box({ x: 0, y: 0, z, w: SEGMENT_WIDTH.bounce, h: 1, d: 18, color, bevel: true });
      this.addRail(-5.6, z, 16);
      this.addRail(5.6, z, 16);
      for (const [x, oz] of [
        [-3, 5],
        [2.5, 2],
        [0, -2],
        [-2.7, -5.5]
      ])
        this.addSpring(x * mirror, 0.68, z + (variant === 2 ? -oz : oz), 1.15);
    }
    if (type === 'crosswind') {
      this.box({ x: 0, y: 0, z, w: SEGMENT_WIDTH.crosswind, h: 1, d: 18, color, bevel: true });
      this.addRail(-4.1, z, 16);
      this.addRail(4.1, z, 16);
      for (const [j, oz] of [
        [0, 4.8],
        [1, -0.2],
        [2, -5]
      ])
        this.addSpinner(
          (j % 2 ? 2.2 : -2.2) * mirror,
          1.1,
          z + oz,
          7.2,
          0.34,
          speed * (1.55 + j * 0.14) * (j % 2 ? -1 : 1) * (variant === 2 ? -1 : 1),
          j
        );
    }
    const endZ = -18 * (index + 1);
    this.box({
      x: 0,
      y: 0.53,
      z: endZ,
      w: type === 'bridge' ? 3.25 : Math.min(10, type === 'movers' ? 10 : 11),
      h: 0.055,
      d: 0.48,
      color: COLORS.mint,
      collider: false,
      emissive: COLORS.mint,
      emissiveIntensity: 1.4
    });
  }
  addSpinner(x, y, z, length, width, speed, phase) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(length, 0.38, width),
      this.material({ color: COLORS.yellow, roughness: 0.24 })
    );
    bar.castShadow = true;
    pivot.add(bar);
    // Ступица — чистая декорация, коллайдера у неё нет: столкновение считается по самой балке.
    this.cylinder({ x, y: y + 0.18, z, r: 0.5, h: 0.75, color: COLORS.purpleDark });
    this.group.add(pivot);
    this.obstacles.push({
      type: 'spinner',
      mesh: pivot,
      length,
      width,
      speed,
      phase,
      center: new THREE.Vector3(x, y, z),
      height: 0.7
    });
  }
  addBumper(x, y, z, radius, color) {
    // Подставка — декорация; отталкивание считается по верхнему цилиндру.
    this.cylinder({ x, y: 0.58, z, r: radius * 1.12, h: 0.16, color: COLORS.yellow });
    const mesh = this.cylinder({ x, y, z, r: radius, h: 1.55, color });
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 0.82, 0.095, 6, 16),
      this.material({ color: 0xffffff, roughness: 0.2 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y + 0.2, z);
    ring.castShadow = true;
    this.group.add(ring);
    this.obstacles.push({ type: 'bumper', mesh, radius, phase: this.rng() * 6.28 });
  }
  addSpring(x, y, z, radius) {
    const pad = this.cylinder({ x, y, z, r: radius, h: 0.25, color: COLORS.yellow });
    const inner = this.cylinder({ x, y: y + 0.14, z, r: radius * 0.66, h: 0.05, color: COLORS.pink });
    this.obstacles.push({ type: 'spring', mesh: pad, radius, inner, phase: this.rng() * 6.28 });
  }
  addFinish() {
    const end = -18 * this.spec.segmentCount;
    for (let j = 0; j < 4; j++)
      this.box({
        x: 0,
        y: j * 0.32,
        z: end - 2.4 - j * 2.2,
        w: 8 + j * 0.35,
        h: 0.65,
        d: 2.45,
        color: palette[(this.spec.segmentCount + j) % palette.length],
        bevel: true
      });
    const finishCenter = this.spec.finishZ + 1.5;
    this.box({ x: 0, y: 1.02, z: finishCenter, w: 11, h: 0.7, d: 6, color: COLORS.yellow, bevel: true });
    for (const x of [-5, 5])
      this.box({
        x,
        y: 3.15,
        z: this.spec.finishZ,
        w: 0.42,
        h: 4.3,
        d: 0.52,
        color: 0xffffff,
        collider: false
      });
    this.box({
      x: 0,
      y: 5.05,
      z: this.spec.finishZ,
      w: 10.4,
      h: 0.48,
      d: 0.55,
      color: 0xffffff,
      collider: false
    });
    this.box({
      x: 0,
      y: 1.42,
      z: this.spec.finishZ,
      w: 10,
      h: 0.08,
      d: 0.7,
      color: COLORS.pink,
      collider: false,
      emissive: COLORS.pink,
      emissiveIntensity: 2.2
    });
    this.stageNames.push('ВОРОТА ПОБЕДЫ');
  }
  addCheckpointArches() {
    for (let i = 0; i < this.spec.checkpoints.length; i++) {
      const z = this.spec.checkpoints[i],
        color = i === this.spec.checkpoints.length - 1 ? COLORS.yellow : COLORS.mint;
      for (const x of [-5.1, 5.1])
        this.box({ x, y: 1.9, z, w: 0.18, h: 2.8, d: 0.18, color, collider: false });
      this.box({
        x: 0,
        y: 3.25,
        z,
        w: 10.4,
        h: 0.2,
        d: 0.2,
        color,
        collider: false,
        emissive: color,
        emissiveIntensity: 1.8
      });
    }
  }
  // Облака намеренно используют дешёвый Lambert вместо Standard: они далеко, физически корректное
  // освещение на них не читается, а материал у всех клубов один на всю трассу.
  cloudMaterial() {
    const key = 'cloud';
    let cached = this.materials.get(key);
    if (!cached) {
      cached = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.72 });
      this.materials.set(key, cached);
    }
    return cached;
  }
  addScenery() {
    const count = this.quality === 'low' ? 14 : 28;
    for (let i = 0; i < count; i++) {
      const side = i % 2 ? -1 : 1,
        x = side * (10 + this.rng() * 34),
        z = 10 - this.rng() * (Math.abs(this.spec.finishZ) + 45),
        y = -2 + this.rng() * 12;
      if (i % 3 === 0) {
        const cloud = new THREE.Group();
        for (let j = 0; j < 3; j++) {
          const puff = new THREE.Mesh(
            new THREE.SphereGeometry(1.2 + this.rng() * 0.9, 8, 6),
            this.cloudMaterial()
          );
          puff.position.set(j * 1.25, this.rng() * 0.6, this.rng() - 0.5);
          cloud.add(puff);
        }
        cloud.position.set(x, y + 6, z);
        cloud.scale.setScalar(1 + this.rng() * 1.5);
        this.group.add(cloud);
        this.scenery.push({ mesh: cloud, speed: (0.15 + this.rng() * 0.18) * side, baseX: x });
      } else {
        const piece = this.box({
          x,
          y,
          z,
          w: 0.8 + this.rng() * 2.5,
          h: 1.5 + this.rng() * 5,
          d: 0.8 + this.rng() * 2.5,
          color: palette[i % palette.length],
          collider: false
        }).mesh;
        piece.rotation.set(this.rng(), this.rng(), this.rng());
        this.scenery.push({ mesh: piece, speed: (this.rng() - 0.5) * 0.28, baseY: y });
      }
    }
  }
  update(dt, elapsed) {
    this.updateDynamic(elapsed);
    for (const obstacle of this.obstacles) {
      if (obstacle.type === 'spinner') {
        obstacle.angle = elapsed * obstacle.speed + obstacle.phase;
        obstacle.mesh.rotation.y = obstacle.angle;
      } else if (obstacle.type === 'puncher') {
        obstacle.mesh.position.x =
          obstacle.originX + Math.sin(elapsed * obstacle.speed + obstacle.phase) * obstacle.range;
      } else if (obstacle.type === 'bumper') {
        obstacle.mesh.scale.y = 1 + Math.sin(elapsed * 2.2 + obstacle.phase) * 0.045;
      } else if (obstacle.type === 'spring') {
        const s = 1 + Math.sin(elapsed * 3 + obstacle.phase) * 0.04;
        obstacle.inner.scale.set(s, 1, s);
      }
    }
    for (const item of this.scenery) {
      if (item.baseX !== undefined)
        item.mesh.position.x = item.baseX + Math.sin(elapsed * 0.08 + item.baseX) * 2;
      item.mesh.rotation.y += item.speed * dt;
    }
  }
  // Реакция на препятствия. Вызывается из шага физики.
  //
  // `pos` — это позиция ФИЗИКИ, а не отрисовки. Разница принципиальна: выталкивание из препятствия
  // меняет позицию напрямую, а позиция отрисовки пересчитывается заново каждый кадр интерполяцией,
  // так что записанное в неё было бы немедленно затёрто.
  interact(player, now, effects, sfx = null) {
    const pos = player.position,
      radius = 0.42,
      // Пружина сюда не входит: она не бьёт, а помогает, и цель «без попаданий» не должна
      // запрещать пользоваться трамплином.
      knockback = this.spec.modifier?.knockback || 1;
    for (const o of this.obstacles) {
      const key = o.mesh.uuid,
        last = player.hitTimes.get(key) || 0;
      if (o.type === 'spring') {
        const dx = pos.x - o.mesh.position.x,
          dz = pos.z - o.mesh.position.z;
        if (
          Math.hypot(dx, dz) < o.radius * 0.82 &&
          Math.abs(pos.y - PLAYER_FOOT - (o.mesh.position.y + 0.13)) < 0.38 &&
          player.velocity.y <= 1 &&
          now - last > 0.35
        ) {
          player.velocity.y = 11.4;
          player.grounded = false;
          player.hitTimes.set(key, now);
          effects.burst(pos, COLORS.yellow, 14, 1.1);
          player.character.landed(0.6);
          sfx?.spring();
          player.impact = Math.max(player.impact, 0.25);
        }
        continue;
      }
      if (o.type === 'bumper') {
        const dx = pos.x - o.mesh.position.x,
          dz = pos.z - o.mesh.position.z,
          dist = Math.hypot(dx, dz) || 0.01,
          min = o.radius + radius;
        if (dist < min && Math.abs(pos.y - o.mesh.position.y) < 1.55 && now - last > 0.28) {
          const nx = dx / dist,
            nz = dz / dist;
          pos.x = o.mesh.position.x + nx * min;
          pos.z = o.mesh.position.z + nz * min;
          player.velocity.x = nx * 10 * knockback;
          player.velocity.z = nz * 10 * knockback;
          player.velocity.y = Math.max(6.2 * knockback, player.velocity.y);
          player.grounded = false;
          player.hitTimes.set(key, now);
          player.hits++;
          effects.burst(pos, o.mesh.material.color.getHex(), 16, 1.15);
          sfx?.bumper();
          player.impact = Math.max(player.impact, 0.4);
        }
        continue;
      }
      if (o.type === 'spinner') {
        const dx = pos.x - o.center.x,
          dz = pos.z - o.center.z,
          cos = Math.cos(o.angle),
          sin = Math.sin(o.angle),
          along = dx * cos - dz * sin,
          cross = dx * sin + dz * cos;
        if (
          Math.abs(along) < o.length / 2 + radius &&
          Math.abs(cross) < o.width / 2 + radius &&
          Math.abs(pos.y - o.center.y) < 1.05 &&
          now - last > 0.32
        ) {
          const side = Math.sign(cross) || 1,
            nx = sin * side,
            nz = cos * side;
          pos.x += nx * (o.width / 2 + radius - Math.abs(cross) + 0.04);
          pos.z += nz * (o.width / 2 + radius - Math.abs(cross) + 0.04);
          const tangential = Math.min(12, Math.abs(o.speed) * Math.abs(along) * 0.72 + 5.5);
          player.velocity.x = (nx * tangential + o.speed * dz * 0.22) * knockback;
          player.velocity.z = (nz * tangential - o.speed * dx * 0.22) * knockback;
          player.velocity.y = Math.max(4.6 * knockback, player.velocity.y);
          player.grounded = false;
          player.hitTimes.set(key, now);
          player.hits++;
          effects.burst(pos, COLORS.yellow, 12, 1);
          sfx?.spinner();
          player.impact = Math.max(player.impact, 0.5);
        }
        continue;
      }
      if (o.type === 'puncher') {
        const dx = pos.x - o.mesh.position.x,
          dz = pos.z - o.mesh.position.z;
        if (
          Math.abs(dx) < o.w / 2 + radius &&
          Math.abs(dz) < o.d / 2 + radius &&
          Math.abs(pos.y - o.mesh.position.y) < 1.5 &&
          now - last > 0.34
        ) {
          const dir = Math.sign(dx) || Math.sign(Math.cos(now * o.speed + o.phase)) || 1;
          pos.x += dir * (o.w / 2 + radius - Math.abs(dx) + 0.05);
          player.velocity.x = dir * 10.5 * knockback;
          player.velocity.z -= 3 * knockback;
          player.velocity.y = Math.max(4.2 * knockback, player.velocity.y);
          player.grounded = false;
          player.hitTimes.set(key, now);
          player.hits++;
          effects.burst(pos, COLORS.pink, 12, 1);
          sfx?.puncher();
          player.impact = Math.max(player.impact, 0.55);
        }
      }
    }
  }
  checkpointFor(position, current) {
    let next = current;
    while (
      next < this.spec.checkpoints.length &&
      position.z < this.spec.checkpoints[next] &&
      position.y > -3 &&
      Math.abs(position.x) < 10
    )
      next++;
    return next;
  }
  spawnFor(checkpoint) {
    if (checkpoint <= 0) return new THREE.Vector3(this.spec.start.x, this.spec.start.y, this.spec.start.z);
    const z = this.spec.checkpoints[Math.min(checkpoint - 1, this.spec.checkpoints.length - 1)] + 3.1;
    return new THREE.Vector3(0, 1.15, z);
  }
  progress(position, checkpoint) {
    const total = Math.abs(this.spec.finishZ - this.spec.start.z),
      travelled = Math.max(0, this.spec.start.z - position.z);
    return Math.max(checkpoint / this.spec.segmentCount, Math.min(0.995, travelled / total));
  }
  stageAt(checkpoint) {
    return this.stageNames[Math.min(checkpoint, this.stageNames.length - 1)] || courseName(this.spec.seed);
  }
  dispose() {
    super.dispose();
    this.scenery.length = 0;
    this.stageNames.length = 0;
  }
}
