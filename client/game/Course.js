import * as THREE from 'three';
import { CourseBuilder } from './CourseBuilder.js';
import { PLAYER_FOOT, PLAYER_OBSTACLE_RADIUS } from './PlayerDimensions.js';
import { addBumper, addRail, addSpinner, addSpring } from '/shared/courseObstacles.js';
import { buildRaceGeometry } from '/shared/raceCourseGeometry.js';
import { applyObstacleImpulses } from '/shared/courseImpulses.js';
import { crossedCheckpoint } from '/shared/courseProgress.js';
import { COLORS, courseName, courseSpec, seededRandom } from '../core/Config.js';

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
  // Расстановка вызывает эти примитивы по именам, поэтому имена остаются методами, а тела живут в
  // общем коде: сервер обязан получить те же препятствия с теми же фазами.
  addRail(x, z, length) {
    addRail(this, x, z, length);
  }
  addSpinner(x, y, z, length, width, speed, phase) {
    addSpinner(this, x, y, z, length, width, speed, phase);
  }
  addBumper(x, y, z, radius, color) {
    addBumper(this, x, y, z, radius, color);
  }
  addSpring(x, y, z, radius) {
    addSpring(this, x, y, z, radius);
  }
  build() {
    buildRaceGeometry(this, this.spec);
    this.addCheckpointArches();
    this.addScenery();
  }
  // Названия этапов — часть подачи, но порядок им задаёт та же расстановка, поэтому они приходят
  // из общей геометрии, а не считаются заново.
  stageName(name) {
    this.stageNames.push(name);
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
        this.moveObstacle(
          obstacle,
          'x',
          obstacle.originX + Math.sin(elapsed * obstacle.speed + obstacle.phase) * obstacle.range
        );
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
  // Реакция на препятствия. Вызывается из шага физики.
  //
  // Сами импульсы считает общее ядро: серверная симуляция обязана получать от трассы тот же
  // отскок и тот же удар, иначе паритет движения не на чем доказывать. Здесь остаётся подача и то,
  // что физика не решает, — счётчик попаданий и сбивание с его собственными правилами.
  interact(player, now, effects, sfx = null) {
    const { events } = applyObstacleImpulses(player, {
      obstacles: this.obstacles,
      now,
      hitTimes: player.hitTimes,
      playerRadius: PLAYER_OBSTACLE_RADIUS,
      footOffset: PLAYER_FOOT,
      // Пружина сюда не входит: она не бьёт, а помогает, и цель «без попаданий» не должна
      // запрещать пользоваться трамплином.
      knockback: this.spec.modifier?.knockback || 1
    });

    for (const event of events) {
      if (event.counted) player.hits++;
      player.impact = Math.max(player.impact, event.impact);
      if (event.name === 'spring') {
        effects.burst(event.at, COLORS.yellow, 14, 1.1);
        player.character.landed(0.6);
        sfx?.spring();
      } else if (event.name === 'bumper') {
        effects.burst(event.at, event.color, 16, 1.15);
        sfx?.bumper();
      } else if (event.name === 'spinner') {
        effects.burst(event.at, COLORS.yellow, 12, 1);
        sfx?.spinner();
      } else if (event.name === 'puncher') {
        effects.burst(event.at, COLORS.pink, 12, 1);
        sfx?.puncher();
      }
      if (event.knockdown) player.knockDown?.(event.knockdown);
    }
  }
  // Арка засчитывается по ПЕРЕСЕЧЕНИЮ её плоскости — тем же общим правилом, что и на сервере.
  //
  // Раньше здесь стоял вопрос «я за чертой?» по текущему положению. Он выглядит равнозначным, но
  // им не является: пересечь плоскость вне рамок можно только один раз, а «оказаться за чертой» —
  // сколько угодно раз подряд. Игрок, пролетевший СБОКУ от арки над пустотой, получал её здесь
  // позже, когда его сносило обратно к оси уже за ней, — а сервер не получал её никогда. Дальше
  // клиент считал трассу пройденной и слал финиш, которого сервер принять не мог.
  checkpointFor(previous, position, current) {
    if (current >= this.spec.checkpoints.length) return current;
    return crossedCheckpoint(previous, position, this.spec.checkpoints[current]) ? current + 1 : current;
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
