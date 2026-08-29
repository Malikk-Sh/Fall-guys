import * as THREE from 'three';
import { CourseBuilder } from './CourseBuilder.js';
import { buildCourseScenery, updateCourseScenery } from './CourseScenery.js';
import { PLAYER_FOOT, PLAYER_OBSTACLE_RADIUS } from './PlayerDimensions.js';
import { addBumper, addRail, addSpinner, addSpring } from '/shared/courseObstacles.js';
import { buildRaceGeometry } from '/shared/raceCourseGeometry.js';
import { applyObstacleImpulses } from '/shared/courseImpulses.js';
import { VISUAL_TOKENS } from '/shared/palette.js';
import { COLORS, courseName, courseSpec, seededRandom } from '../core/Config.js';

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
        color =
          i === this.spec.checkpoints.length - 1 ? VISUAL_TOKENS.finishAccent : VISUAL_TOKENS.checkpoint;
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
  addScenery() {
    this.scenery.push(...buildCourseScenery(this));
  }
  update(_dt, elapsed) {
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
    updateCourseScenery(this.scenery, elapsed);
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
