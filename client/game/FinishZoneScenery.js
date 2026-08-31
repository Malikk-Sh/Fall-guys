import * as THREE from 'three';
import { VISUAL_TOKENS } from '/shared/palette.js';

function decorativeMesh(course, group, geometry, material, name) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);
  return mesh;
}

function addSidePodium(course, group, side) {
  const x = side * 7.3;
  const top = decorativeMesh(
    course,
    group,
    new THREE.CylinderGeometry(1.65, 1.85, 0.52, course.quality === 'low' ? 10 : 16),
    course.material({ color: VISUAL_TOKENS.surfacePrimary, roughness: 0.5 }),
    `finish-side-podium-${side < 0 ? 'left' : 'right'}`
  );
  top.position.set(x, -0.35, 1.2);

  const underside = decorativeMesh(
    course,
    group,
    new THREE.ConeGeometry(1.5, 2.3, course.quality === 'low' ? 10 : 16),
    course.material({ color: VISUAL_TOKENS.surfaceSecondary, roughness: 0.64 }),
    `finish-side-podium-under-${side < 0 ? 'left' : 'right'}`
  );
  underside.rotation.z = Math.PI;
  underside.position.set(x, -1.72, 1.2);
}

function addCelebrationPylon(course, group, side) {
  const x = side * 6.55;
  const post = decorativeMesh(
    course,
    group,
    new THREE.CylinderGeometry(0.14, 0.2, 3.6, course.quality === 'low' ? 7 : 10),
    course.material({ color: VISUAL_TOKENS.rail, roughness: 0.44 }),
    `finish-pylon-${side < 0 ? 'left' : 'right'}`
  );
  post.position.set(x, 1.55, 0.2);

  const balloonCount = course.quality === 'low' ? 1 : 3;
  const colors = [VISUAL_TOKENS.finish, VISUAL_TOKENS.finishAccent, VISUAL_TOKENS.checkpoint];
  for (let i = 0; i < balloonCount; i++) {
    const balloon = decorativeMesh(
      course,
      group,
      new THREE.SphereGeometry(0.46, course.quality === 'low' ? 8 : 12, course.quality === 'low' ? 6 : 8),
      course.material({ color: colors[i], roughness: 0.34, emissive: colors[i], emissiveIntensity: 0.2 }),
      `finish-balloon-${side < 0 ? 'left' : 'right'}-${i}`
    );
    balloon.scale.y = 1.15;
    balloon.position.set(x + side * (i - 1) * 0.52, 3.72 + (i % 2) * 0.38, 0.2 + (i - 1) * 0.16);
  }
}

function addBannerLine(course, group) {
  const line = decorativeMesh(
    course,
    group,
    new THREE.BoxGeometry(9.2, 0.06, 0.06),
    course.material({ color: VISUAL_TOKENS.rail, roughness: 0.42 }),
    'finish-banner-line'
  );
  line.position.set(0, 5.35, 0.15);

  const count = course.quality === 'low' ? 3 : 7;
  const colors = [VISUAL_TOKENS.finish, VISUAL_TOKENS.finishAccent, VISUAL_TOKENS.checkpoint];
  for (let i = 0; i < count; i++) {
    const banner = decorativeMesh(
      course,
      group,
      new THREE.BoxGeometry(0.72, 0.58, 0.08),
      course.material({
        color: colors[i % colors.length],
        roughness: 0.38,
        emissive: colors[i % colors.length],
        emissiveIntensity: 0.18
      }),
      `finish-banner-${i}`
    );
    const t = count === 1 ? 0.5 : i / (count - 1);
    banner.position.set(THREE.MathUtils.lerp(-3.75, 3.75, t), 5.02, 0.15);
    banner.rotation.z = (i % 2 ? -1 : 1) * 0.08;
  }
}

// Финиш остаётся gameplay-геометрией из shared/raceCourseGeometry.js. Этот модуль только обрамляет
// уже существующие ворота: боковые острова, celebratory pylons/balloons и banner line не входят ни
// в platform records, ни в camera occlusion, ни в finish validation.
export function buildFinishZoneScenery(course) {
  const group = new THREE.Group();
  group.name = 'finish-celebration-zone';
  group.userData.sceneryOnly = true;
  group.position.set(0, 0, course.spec.finishZ + 0.35);

  for (const side of [-1, 1]) {
    addSidePodium(course, group, side);
    addCelebrationPylon(course, group, side);
  }
  addBannerLine(course, group);

  course.group.add(group);
  return group;
}
