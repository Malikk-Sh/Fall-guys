import * as THREE from 'three';
import {
  cachedGeometry,
  cachedMaterial,
  capsuleGeometry,
  sphere,
  torus,
  standardMaterial,
  glowMaterial
} from './CosmeticResources.js';
import { applySurface } from './CharacterSurface.js';

export function roundedBox(width, height, depth, radius = 0.03) {
  return cachedGeometry(`rounded:${width}:${height}:${depth}:${radius}`, () => {
    const geometry = new THREE.BoxGeometry(width, height, depth, 4, 4, 4);
    const position = geometry.attributes.position,
      normal = geometry.attributes.normal;
    const half = [width / 2, height / 2, depth / 2];
    const bevel = Math.min(radius, ...half);
    const point = new THREE.Vector3(),
      core = new THREE.Vector3();
    for (let index = 0; index < position.count; index++) {
      point.fromBufferAttribute(position, index);
      core.set(
        THREE.MathUtils.clamp(point.x, -half[0] + bevel, half[0] - bevel),
        THREE.MathUtils.clamp(point.y, -half[1] + bevel, half[1] - bevel),
        THREE.MathUtils.clamp(point.z, -half[2] + bevel, half[2] - bevel)
      );
      point.sub(core).normalize();
      normal.setXYZ(index, point.x, point.y, point.z);
      point.multiplyScalar(bevel).add(core);
      position.setXYZ(index, point.x, point.y, point.z);
    }
    geometry.computeBoundingSphere();
    return geometry;
  });
}

const surface = (color, kind) =>
  cachedMaterial(`signature:${color}:${kind}`, () => {
    const material = new THREE.MeshPhysicalMaterial({ color });
    applySurface(material, kind);
    return material;
  });

function add(group, geometry, material, x, y, z, scale = null, micro = false) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  if (scale) mesh.scale.set(...scale);
  mesh.castShadow = !micro;
  mesh.receiveShadow = true;
  if (micro) mesh.userData.cosmeticRole = 'micro';
  group.add(mesh);
  return mesh;
}

function band(group, radius, tube, material, y) {
  const ring = add(group, torus(radius, tube, 40), material, 0, y, 0);
  ring.rotation.x = Math.PI / 2;
  ring.scale.y = 0.92;
  return ring;
}

function astronaut(render) {
  const group = new THREE.Group();
  const shell = surface(render.primary, 'ceramic'),
    trim = surface(render.accent, 'ceramic');
  const dark = standardMaterial(0x203651, { roughness: 0.72 });
  const helmetRim = add(group, torus(0.337, 0.026, 40), shell, 0, 1.18, -0.48);
  helmetRim.scale.y = 0.65;
  band(group, 0.48, 0.036, trim, 1.02);
  band(group, 0.49, 0.023, dark, 0.57);
  add(group, roundedBox(0.46, 0.34, 0.13, 0.05), shell, 0, 0.8, -0.48);
  add(group, roundedBox(0.32, 0.15, 0.024, 0.012), dark, 0, 0.84, -0.556);
  for (let index = 0; index < 3; index++)
    add(
      group,
      roundedBox(0.065, 0.024, 0.012, 0.006),
      glowMaterial(index === 2 ? 0xffc65b : 0x76f1e1, { intensity: 0.35 }),
      -0.096 + index * 0.096,
      0.855,
      -0.576,
      null,
      true
    );
  for (const side of [-1, 1]) {
    add(group, sphere(0.13, 20), shell, side * 0.442, 1.22, 0, [0.45, 1, 1]);
    add(group, sphere(0.084, 16), trim, side * 0.5, 1.22, 0, [0.24, 1, 1]);
    add(group, sphere(0.16, 20), shell, side * 0.43, 0.99, 0, [0.62, 1, 1]);
    add(group, roundedBox(0.075, 0.16, 0.17), trim, side * 0.493, 0.92, 0);
    add(group, sphere(0.044, 12), dark, side * 0.145, 0.7, -0.555);
    add(group, torus(0.045, 0.011, 20), trim, side * 0.145, 0.7, -0.572);
  }
  return group;
}

function robot(render) {
  const group = new THREE.Group();
  const alloy = surface(render.panel, 'metal'),
    trim = surface(render.accent, 'ceramic');
  const dark = standardMaterial(0x192b3e, { roughness: 0.54, metalness: 0.25 });
  add(group, roundedBox(0.6, 0.48, 0.15, 0.055), dark, 0, 0.81, -0.435);
  add(group, roundedBox(0.54, 0.42, 0.13, 0.045), alloy, 0, 0.82, -0.483);
  add(group, roundedBox(0.29, 0.19, 0.025, 0.025), dark, 0, 0.875, -0.561);
  add(
    group,
    roundedBox(0.23, 0.026, 0.018, 0.008),
    glowMaterial(render.glow, { intensity: 0.5 }),
    0,
    0.89,
    -0.583
  );
  for (const side of [-1, 1]) {
    add(group, roundedBox(0.22, 0.24, 0.33, 0.06), trim, side * 0.455, 1.025, 0);
    for (const y of [0.66, 0.98])
      add(group, sphere(0.026, 10), dark, side * 0.216, y, -0.552, [1, 1, 0.45], true);
  }
  for (let index = 0; index < 4; index++)
    add(group, roundedBox(0.045, 0.07, 0.016, 0.009), dark, -0.105 + index * 0.07, 0.712, -0.557, null, true);
  return group;
}

function mooncat(render) {
  const group = new THREE.Group();
  const plush = surface(render.primary, 'plush'),
    inner = surface(render.belly, 'fabric'),
    trim = surface(render.accent, 'ceramic');
  const earGeometry = cachedGeometry('signature-cat-ear', () => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.15, -0.12);
    shape.quadraticCurveTo(-0.17, -0.08, -0.12, 0.06);
    shape.lineTo(-0.04, 0.22);
    shape.quadraticCurveTo(0, 0.28, 0.04, 0.22);
    shape.lineTo(0.12, 0.06);
    shape.quadraticCurveTo(0.17, -0.08, 0.15, -0.12);
    shape.quadraticCurveTo(0, -0.18, -0.15, -0.12);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.1,
      bevelEnabled: true,
      bevelSegments: 3,
      bevelSize: 0.018,
      bevelThickness: 0.02,
      curveSegments: 6,
      steps: 1
    });
    geometry.translate(0, 0, -0.05);
    return geometry;
  });
  for (const side of [-1, 1]) {
    const ear = add(group, earGeometry, plush, side * 0.265, 1.5, 0);
    ear.rotation.z = -side * 0.26;
    ear.userData.cosmeticRole = 'ear';
    add(ear, earGeometry, inner, 0, 0.005, -0.065, [0.64, 0.68, 0.24]);
    add(group, sphere(0.092, 16), inner, side * 0.135, 1.045, -0.477, [1.1, 0.65, 0.62]);
  }
  add(group, sphere(0.037, 12), standardMaterial(0x55416f), 0, 1.08, -0.536, [1, 0.75, 0.8]);
  band(group, 0.486, 0.027, trim, 0.96);
  add(group, torus(0.06, 0.016, 24), trim, 0, 0.9, -0.493);
  const tail = new THREE.Group();
  tail.position.set(0, 0.67, 0.44);
  tail.userData.cosmeticRole = 'tail';
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.15, -0.08, 0.2),
    new THREE.Vector3(0.28, 0.05, 0.25),
    new THREE.Vector3(0.22, 0.24, 0.22)
  ]);
  add(
    tail,
    cachedGeometry('signature-cat-tail', () => new THREE.TubeGeometry(curve, 20, 0.065, 10, false)),
    plush,
    0,
    0,
    0
  );
  group.add(tail);
  return group;
}

function donut(render) {
  const group = new THREE.Group();
  const dough = surface(render.primary, 'pastry'),
    icing = surface(render.accent, 'ceramic');
  const ring = add(group, torus(0.32, 0.145, 48), dough, 0, 0.78, -0.435);
  ring.scale.y = 0.82;
  const glaze = add(group, torus(0.32, 0.112, 48), icing, 0, 0.795, -0.52);
  glaze.scale.y = 0.82;
  for (let index = 0; index < 5; index++) {
    const angle = Math.PI + (index / 4) * Math.PI;
    add(
      group,
      sphere(0.046, 12),
      icing,
      Math.cos(angle) * 0.31,
      0.795 + Math.sin(angle) * 0.27,
      -0.526,
      [0.72, 1.65, 0.85]
    );
  }
  const colors = [0x77e8cf, 0xffdd75, 0xfcf2dc, 0x7755bd];
  for (let index = 0; index < 12; index++) {
    const angle = (index / 12) * Math.PI * 2;
    const chip = add(
      group,
      capsuleGeometry(0.012, 0.035, 8),
      standardMaterial(colors[index % colors.length]),
      Math.cos(angle) * 0.32,
      0.795 + Math.sin(angle) * 0.262,
      -0.632,
      null,
      true
    );
    chip.rotation.z = angle * 2.4;
  }
  return group;
}

const BUILDERS = Object.freeze({ astronaut, robot, mooncat, donut });
export function buildSignatureCostume(render) {
  return BUILDERS[render?.signature]?.(render) || null;
}
