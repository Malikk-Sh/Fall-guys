import * as THREE from 'three';
import { COLORS, VISUAL_TOKENS } from '/shared/palette.js';
import { FIRST_SEGMENT_CENTER, SEGMENT_LENGTH } from '/shared/courseSpec.js';

const STAGE_ACCENT = Object.freeze({
  sweepers: COLORS.yellow,
  movers: COLORS.cyan,
  bumpers: COLORS.pink,
  bridge: COLORS.mint,
  punchers: COLORS.pink,
  bounce: COLORS.yellow,
  crosswind: COLORS.cyan
});

function mesh(course, geometry, color, name, emissiveIntensity = 0.16) {
  const item = new THREE.Mesh(
    geometry,
    course.material({
      color,
      roughness: 0.38,
      emissive: color,
      emissiveIntensity
    })
  );
  item.name = name;
  item.castShadow = false;
  item.receiveShadow = false;
  return item;
}

function addSweepersIcon(course, group, accent) {
  for (let arm = 0; arm < 2; arm++) {
    const bar = mesh(course, new THREE.BoxGeometry(1.5, 0.16, 0.24), accent, `stage-icon-sweeper-${arm}`);
    bar.rotation.z = arm * Math.PI * 0.5;
    group.add(bar);
  }
}

function addMoversIcon(course, group, accent) {
  for (let step = 0; step < 3; step++) {
    const block = mesh(course, new THREE.BoxGeometry(0.64, 0.18, 0.48), accent, `stage-icon-mover-${step}`);
    block.position.set((step - 1) * 0.52, step * 0.32 - 0.28, 0);
    group.add(block);
  }
}

function addBumpersIcon(course, group, accent) {
  for (const [index, [x, y]] of [
    [-0.52, -0.1],
    [0, 0.38],
    [0.52, -0.1]
  ].entries()) {
    const orb = mesh(course, new THREE.SphereGeometry(0.3, 10, 7), accent, `stage-icon-bumper-${index}`);
    orb.position.set(x, y, 0);
    group.add(orb);
  }
}

function addBridgeIcon(course, group, accent) {
  const deck = mesh(course, new THREE.BoxGeometry(1.5, 0.16, 0.42), accent, 'stage-icon-bridge-deck');
  group.add(deck);
  for (const side of [-1, 1]) {
    const rail = mesh(
      course,
      new THREE.BoxGeometry(0.12, 0.68, 0.12),
      VISUAL_TOKENS.rail,
      `stage-icon-bridge-${side}`
    );
    rail.position.set(side * 0.62, 0.36, 0);
    group.add(rail);
  }
}

function addPuncherIcon(course, group, accent) {
  const head = mesh(course, new THREE.BoxGeometry(1.05, 0.62, 0.52), accent, 'stage-icon-puncher-head');
  head.position.y = 0.16;
  group.add(head);
  const stem = mesh(
    course,
    new THREE.BoxGeometry(0.22, 0.78, 0.22),
    VISUAL_TOKENS.rail,
    'stage-icon-puncher-stem'
  );
  stem.position.y = -0.45;
  group.add(stem);
}

function addBounceIcon(course, group, accent) {
  for (const [index, radius] of [0.62, 0.36].entries()) {
    const ring = mesh(
      course,
      new THREE.TorusGeometry(radius, 0.1, 6, 14),
      index === 0 ? accent : COLORS.cyan,
      `stage-icon-bounce-${index}`
    );
    group.add(ring);
  }
}

function addCrosswindIcon(course, group, accent) {
  for (let arm = 0; arm < 3; arm++) {
    const blade = mesh(course, new THREE.BoxGeometry(1.2, 0.14, 0.22), accent, `stage-icon-wind-${arm}`);
    blade.rotation.z = (Math.PI / 3) * arm;
    group.add(blade);
  }
  const hub = mesh(course, new THREE.SphereGeometry(0.22, 9, 7), COLORS.yellow, 'stage-icon-wind-hub');
  group.add(hub);
}

function addHighDetailIcon(course, group, type, accent) {
  if (type === 'sweepers') addSweepersIcon(course, group, accent);
  else if (type === 'movers') addMoversIcon(course, group, accent);
  else if (type === 'bumpers') addBumpersIcon(course, group, accent);
  else if (type === 'bridge') addBridgeIcon(course, group, accent);
  else if (type === 'punchers') addPuncherIcon(course, group, accent);
  else if (type === 'bounce') addBounceIcon(course, group, accent);
  else if (type === 'crosswind') addCrosswindIcon(course, group, accent);
}

function stageLandmark(course, segment, index) {
  const type = segment.type;
  const accent = STAGE_ACCENT[type] ?? VISUAL_TOKENS.checkpoint;
  const side = index % 2 === 0 ? -1 : 1;
  const group = new THREE.Group();
  group.name = `stage-landmark-${index}-${type}`;
  group.userData.sceneryOnly = true;
  group.userData.stageType = type;
  group.position.set(side * 7.15, 1.45, FIRST_SEGMENT_CENTER - index * SEGMENT_LENGTH);
  group.rotation.y = side < 0 ? 0.12 : -0.12;

  const mast = mesh(
    course,
    new THREE.CylinderGeometry(0.12, 0.18, 2.4, course.quality === 'low' ? 7 : 10),
    VISUAL_TOKENS.rail,
    `stage-landmark-mast-${index}`,
    0
  );
  mast.position.y = -0.3;
  group.add(mast);

  const beacon = mesh(
    course,
    new THREE.SphereGeometry(0.4, course.quality === 'low' ? 8 : 12, course.quality === 'low' ? 6 : 8),
    accent,
    `stage-landmark-beacon-${index}`,
    0.34
  );
  beacon.position.y = 1.05;
  group.add(beacon);

  if (course.quality !== 'low') {
    const icon = new THREE.Group();
    icon.name = `stage-landmark-icon-${index}`;
    icon.position.set(-side * 0.72, 0.35, 0);
    icon.rotation.y = Math.PI / 2;
    addHighDetailIcon(course, icon, type, accent);
    group.add(icon);
  }

  course.group.add(group);
  return group;
}

// Planner и shared geometry уже определяют порядок/тип секций. Здесь этот факт только получает
// визуальный язык: боковой landmark помогает понять следующий участок издалека и не добавляет
// ни collider, ни camera occluder, ни отдельный update clock.
export function buildStageIdentityScenery(course) {
  return (course.spec.segments || []).map((segment, index) => stageLandmark(course, segment, index));
}
