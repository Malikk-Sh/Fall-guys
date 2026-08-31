import * as THREE from 'three';
import { COLORS } from '../core/Config.js';

function bar(width, depth, material, name) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.045, depth), material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = name;
  return mesh;
}

function addArrowHead(group, direction, material, prefix) {
  for (const side of [-1, 1]) {
    const arm = bar(0.46, 0.1, material, `${prefix}-${direction > 0 ? 'forward' : 'back'}-${side}`);
    arm.position.set(direction * 0.66, 0, side * 0.13);
    arm.rotation.y = side * direction * 0.58;
    group.add(arm);
  }
}

function movingPlatformCue(course, platform, index) {
  const axis = platform.motion?.axis;
  if (axis !== 'x' && axis !== 'z') return null;

  const group = new THREE.Group();
  group.name = `moving-platform-cue-${index}`;
  group.userData.motionAxis = axis;
  group.position.y = platform.h / 2 + 0.035;
  if (axis === 'z') group.rotation.y = Math.PI / 2;

  const arrowMaterial = course.material({
    color: COLORS.yellow,
    roughness: 0.3,
    emissive: COLORS.yellow,
    emissiveIntensity: 0.58
  });
  const spine = bar(1.12, 0.1, arrowMaterial, `moving-platform-spine-${index}`);
  group.add(spine);
  addArrowHead(group, -1, arrowMaterial, `moving-platform-head-${index}`);
  addArrowHead(group, 1, arrowMaterial, `moving-platform-head-${index}`);

  if (course.quality !== 'low') {
    const trimMaterial = course.material({
      color: COLORS.cyan,
      roughness: 0.3,
      emissive: COLORS.cyan,
      emissiveIntensity: 0.42
    });
    for (const side of [-1, 1]) {
      const trim = bar(1.72, 0.055, trimMaterial, `moving-platform-trim-${index}-${side}`);
      trim.position.z = side * 0.42;
      group.add(trim);
    }
  }

  // Cue живёт в локальных координатах самой опоры. Поэтому подтверждённое gameplay-движение
  // автоматически переносит и декор — отдельный animation clock или копия motion formula не нужны.
  platform.mesh.add(group);
  return group;
}

export function buildMovingPlatformTelegraphs(course) {
  const cues = [];
  for (let index = 0; index < course.dynamic.length; index++) {
    const cue = movingPlatformCue(course, course.dynamic[index], index);
    if (cue) cues.push(cue);
  }
  return cues;
}
