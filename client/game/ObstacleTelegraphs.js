import * as THREE from 'three';
import { COLORS } from '../core/Config.js';

function disc(course, { x, y, z, radius, height = 0.08, color, emissive = null, name }) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, course.quality === 'low' ? 10 : 20),
    course.material({
      color,
      roughness: 0.34,
      emissive,
      emissiveIntensity: emissive === null ? 1 : 0.85
    })
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = course.quality !== 'low';
  mesh.receiveShadow = true;
  mesh.name = name;
  course.group.add(mesh);
  return mesh;
}

function addBurstMark(course, obstacle, y, radius, index) {
  if (course.quality === 'low') return [];
  const marks = [];
  for (let arm = 0; arm < 3; arm++) {
    const decor = course.box({
      x: obstacle.x,
      y,
      z: obstacle.z,
      w: radius * 1.15,
      h: 0.045,
      d: radius * 0.2,
      color: COLORS.pink,
      collider: false,
      emissive: COLORS.pink,
      emissiveIntensity: 0.55
    });
    decor.mesh.rotation.y = (Math.PI / 3) * arm;
    decor.mesh.name = `telegraph-bumper-mark-${index}-${arm}`;
    marks.push(decor.mesh);
  }
  return marks;
}

function bumperTelegraph(course, obstacle, index) {
  const radius = obstacle.radius * 0.92;
  const y = obstacle.y + 0.81;
  const cap = disc(course, {
    x: obstacle.x,
    y,
    z: obstacle.z,
    radius,
    height: 0.09,
    color: COLORS.yellow,
    emissive: COLORS.yellow,
    name: `telegraph-bumper-cap-${index}`
  });
  const ring = course.ringDecor({
    x: obstacle.x,
    y: y + 0.055,
    z: obstacle.z,
    radius: radius * 0.72
  });
  ring.name = `telegraph-bumper-ring-${index}`;
  return [cap, ring, ...addBurstMark(course, obstacle, y + 0.075, radius, index)];
}

function springTelegraph(course, obstacle, index) {
  const y = obstacle.y + 0.19;
  const ring = course.ringDecor({
    x: obstacle.x,
    y,
    z: obstacle.z,
    radius: obstacle.radius * 0.72
  });
  ring.name = `telegraph-spring-ring-${index}`;
  const center = disc(course, {
    x: obstacle.x,
    y: y + 0.025,
    z: obstacle.z,
    radius: obstacle.radius * 0.22,
    height: 0.055,
    color: COLORS.cyan,
    emissive: COLORS.cyan,
    name: `telegraph-spring-center-${index}`
  });
  return [ring, center];
}

function spinnerTelegraph(course, obstacle, index) {
  const cap = disc(course, {
    x: obstacle.x,
    y: obstacle.y + 0.68,
    z: obstacle.z,
    radius: 0.48,
    height: 0.1,
    color: COLORS.cyan,
    emissive: COLORS.cyan,
    name: `telegraph-spinner-cap-${index}`
  });
  const ring = course.ringDecor({
    x: obstacle.x,
    y: obstacle.y + 0.74,
    z: obstacle.z,
    radius: 0.36
  });
  ring.name = `telegraph-spinner-ring-${index}`;
  return [cap, ring];
}

// Дальняя читаемость препятствий из gameplay capture: крупные верхние caps и контрастные метки
// помогают распознать тип до контакта. Здесь нет коллайдеров, camera meshes или собственных
// таймеров — это только дополнительные дети course.group поверх уже созданных obstacle records.
export function buildObstacleTelegraphs(course) {
  const visuals = [];
  let bumperIndex = 0;
  let springIndex = 0;
  let spinnerIndex = 0;
  for (const obstacle of course.obstacles) {
    if (obstacle.type === 'bumper') visuals.push(...bumperTelegraph(course, obstacle, bumperIndex++));
    else if (obstacle.type === 'spring') visuals.push(...springTelegraph(course, obstacle, springIndex++));
    else if (obstacle.type === 'spinner') visuals.push(...spinnerTelegraph(course, obstacle, spinnerIndex++));
  }
  return visuals;
}
