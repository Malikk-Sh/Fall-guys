import * as THREE from 'three';
import { VISUAL_TOKENS } from '/shared/palette.js';

const CLOUD_LAYERS = [
  { key: 'far', high: 3, low: 2, minX: 28, maxX: 48, y: 12, yJitter: 7, scale: 2.2, opacity: 0.4 },
  { key: 'mid', high: 5, low: 2, minX: 19, maxX: 36, y: 7, yJitter: 6, scale: 1.55, opacity: 0.56 },
  { key: 'near', high: 4, low: 2, minX: 13, maxX: 25, y: 4, yJitter: 5, scale: 1.05, opacity: 0.7 }
];

function cloudMaterial(course, opacity) {
  const key = `scenery-cloud-${opacity}`;
  let material = course.materials.get(key);
  if (material) return material;
  material = new THREE.MeshLambertMaterial({
    color: VISUAL_TOKENS.cloud,
    transparent: true,
    opacity,
    depthWrite: false
  });
  course.materials.set(key, material);
  return material;
}

function sceneryMesh(group, geometry, material) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);
  return mesh;
}

function addCloudLayers(course, animations) {
  const trackLength = Math.abs(course.spec.finishZ - course.spec.start.z);
  for (const layer of CLOUD_LAYERS) {
    const count = course.quality === 'low' ? layer.low : layer.high;
    for (let i = 0; i < count; i++) {
      const side = (i + (layer.key === 'mid' ? 1 : 0)) % 2 ? -1 : 1;
      const cloud = new THREE.Group();
      cloud.name = `scenery-cloud-${layer.key}-${i}`;
      const puffCount = 3;
      for (let j = 0; j < puffCount; j++) {
        const radius = 1.05 + course.rng() * 0.75;
        const puff = sceneryMesh(
          cloud,
          new THREE.SphereGeometry(
            radius,
            course.quality === 'low' ? 6 : 8,
            course.quality === 'low' ? 5 : 6
          ),
          cloudMaterial(course, layer.opacity)
        );
        puff.position.set(
          (j - 1) * 1.15 + (course.rng() - 0.5) * 0.35,
          course.rng() * 0.55,
          course.rng() - 0.5
        );
      }

      const x = side * (layer.minX + course.rng() * (layer.maxX - layer.minX));
      const z = course.spec.start.z + 12 - course.rng() * (trackLength + 36);
      const y = layer.y + course.rng() * layer.yJitter;
      cloud.position.set(x, y, z);
      cloud.scale.setScalar(layer.scale * (0.82 + course.rng() * 0.4));
      course.group.add(cloud);
      animations.push({
        kind: 'cloud',
        mesh: cloud,
        baseX: x,
        phase: course.rng() * Math.PI * 2,
        driftSpeed: 0.045 + course.rng() * 0.035,
        driftAmount: 1.2 + course.rng() * 1.8
      });
    }
  }
}

function addFloatingIsland(course, index, fraction, side, animations) {
  const group = new THREE.Group();
  group.name = `scenery-island-${index}`;
  group.userData.sceneryOnly = true;

  const radius = 2.2 + course.rng() * 1.7;
  const segments = course.quality === 'low' ? 10 : 16;
  const topColor = index % 2 ? VISUAL_TOKENS.surfacePrimary : VISUAL_TOKENS.surfaceSecondary;
  const top = sceneryMesh(
    group,
    new THREE.CylinderGeometry(radius, radius * 0.92, 0.62, segments),
    course.material({ color: topColor, roughness: 0.58 })
  );
  top.position.y = 0;

  const underside = sceneryMesh(
    group,
    new THREE.ConeGeometry(radius * 0.82, 2.6 + course.rng() * 1.2, segments),
    course.material({ color: VISUAL_TOKENS.surfaceSecondary, roughness: 0.68 })
  );
  underside.rotation.z = Math.PI;
  underside.position.y = -1.55;

  if (course.quality !== 'low') {
    const mast = sceneryMesh(
      group,
      new THREE.CylinderGeometry(0.11, 0.14, 1.7, 8),
      course.material({ color: VISUAL_TOKENS.rail, roughness: 0.45 })
    );
    mast.position.set(radius * 0.2, 1.12, 0);
    const balloon = sceneryMesh(
      group,
      new THREE.SphereGeometry(0.42, 10, 7),
      course.material({ color: VISUAL_TOKENS.bounce, roughness: 0.38 })
    );
    balloon.position.set(radius * 0.2, 2.08, 0);
  }

  const x = side * (15 + course.rng() * 15);
  const y = -3.8 + course.rng() * 4.4;
  const z = THREE.MathUtils.lerp(course.spec.start.z, course.spec.finishZ, fraction);
  group.position.set(x, y, z);
  const baseRotation = course.rng() * Math.PI * 2;
  group.rotation.y = baseRotation;
  course.group.add(group);
  animations.push({
    kind: 'island',
    mesh: group,
    baseY: y,
    baseRotation,
    phase: course.rng() * Math.PI * 2,
    bobSpeed: 0.32 + course.rng() * 0.12,
    bobAmount: 0.18 + course.rng() * 0.18,
    spin: (course.rng() - 0.5) * 0.05
  });
}

function addFloatingIslands(course, animations) {
  const count = course.quality === 'low' ? 2 : 5;
  for (let i = 0; i < count; i++) {
    const fraction = (i + 1) / (count + 1) + (course.rng() - 0.5) * 0.06;
    addFloatingIsland(course, i, THREE.MathUtils.clamp(fraction, 0.08, 0.92), i % 2 ? -1 : 1, animations);
  }
}

function addSideLandmark(course, index, fraction, side, color) {
  const group = new THREE.Group();
  group.name = `course-landmark-${index}`;
  group.userData.sceneryOnly = true;

  const ring = sceneryMesh(
    group,
    new THREE.TorusGeometry(1.15, 0.18, 6, course.quality === 'low' ? 14 : 22),
    course.material({ color, roughness: 0.4, emissive: color, emissiveIntensity: 0.35 })
  );
  ring.position.y = 1.35;

  const core = sceneryMesh(
    group,
    new THREE.SphereGeometry(0.42, course.quality === 'low' ? 8 : 12, course.quality === 'low' ? 6 : 8),
    course.material({ color: VISUAL_TOKENS.rail, roughness: 0.36 })
  );
  core.position.y = 1.35;

  const post = sceneryMesh(
    group,
    new THREE.CylinderGeometry(0.13, 0.18, 2.7, course.quality === 'low' ? 6 : 10),
    course.material({ color: VISUAL_TOKENS.surfaceSecondary, roughness: 0.55 })
  );
  post.position.y = -0.12;

  group.position.set(
    side * 13.8,
    3.2 + (index % 2) * 1.2,
    THREE.MathUtils.lerp(course.spec.start.z, course.spec.finishZ, fraction)
  );
  course.group.add(group);
}

function addFinishLandmark(course) {
  const group = new THREE.Group();
  group.name = 'finish-landmark';
  group.userData.sceneryOnly = true;

  const outer = sceneryMesh(
    group,
    new THREE.TorusGeometry(2.65, 0.28, course.quality === 'low' ? 6 : 8, course.quality === 'low' ? 18 : 28),
    course.material({
      color: VISUAL_TOKENS.finishAccent,
      roughness: 0.34,
      emissive: VISUAL_TOKENS.finishAccent,
      emissiveIntensity: 1.25
    })
  );
  outer.name = 'finish-landmark-halo';

  const core = sceneryMesh(
    group,
    new THREE.SphereGeometry(0.68, course.quality === 'low' ? 10 : 16, course.quality === 'low' ? 7 : 10),
    course.material({
      color: VISUAL_TOKENS.finish,
      roughness: 0.3,
      emissive: VISUAL_TOKENS.finish,
      emissiveIntensity: 0.8
    })
  );
  core.name = 'finish-landmark-core';

  if (course.quality !== 'low') {
    for (const x of [-1.35, 1.35]) {
      const bulb = sceneryMesh(
        group,
        new THREE.SphereGeometry(0.36, 10, 7),
        course.material({ color: VISUAL_TOKENS.checkpoint, roughness: 0.34 })
      );
      bulb.position.set(x, 0.15, 0);
    }
  }

  group.position.set(0, 8.4, course.spec.finishZ - 2.2);
  course.group.add(group);
}

function addLandmarks(course) {
  const landmarks =
    course.quality === 'low'
      ? [
          [0.34, 1, VISUAL_TOKENS.checkpoint],
          [0.7, -1, VISUAL_TOKENS.bounce]
        ]
      : [
          [0.23, 1, VISUAL_TOKENS.checkpoint],
          [0.5, -1, VISUAL_TOKENS.bounce],
          [0.76, 1, VISUAL_TOKENS.finish]
        ];
  for (let i = 0; i < landmarks.length; i++) {
    const [fraction, side, color] = landmarks[i];
    addSideLandmark(course, i + 1, fraction, side, color);
  }
  addFinishLandmark(course);
}

export function buildCourseScenery(course) {
  const animations = [];
  addCloudLayers(course, animations);
  addFloatingIslands(course, animations);
  addLandmarks(course);
  return animations;
}

export function updateCourseScenery(animations, elapsed) {
  for (const item of animations) {
    if (item.kind === 'cloud') {
      item.mesh.position.x = item.baseX + Math.sin(elapsed * item.driftSpeed + item.phase) * item.driftAmount;
    } else if (item.kind === 'island') {
      item.mesh.position.y = item.baseY + Math.sin(elapsed * item.bobSpeed + item.phase) * item.bobAmount;
      item.mesh.rotation.y = item.baseRotation + elapsed * item.spin;
    }
  }
}
