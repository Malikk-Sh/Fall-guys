import * as THREE from 'three';
import {
  box,
  capsuleGeometry,
  cone,
  cylinder,
  glowMaterial,
  sphere,
  standardMaterial,
  starGeometry,
  stripeTexture,
  torus,
  translucentMaterial
} from './CosmeticResources.js';

// Реестр render kinds.
//
// Главное правило системы: каталог говорит «kind + параметры», фабрика знает, как это собрать.
// Шестидесяти независимых «движков» здесь нет и быть не должно — есть два десятка форм, которые
// параметризуются цветом, количеством элементов и стилем. Новый предмет чаще всего не требует
// нового кода вовсе: достаточно выбрать существующий kind и подобрать параметры.
//
// Каждая функция возвращает `THREE.Group`, готовую к добавлению в якорь персонажа. Внутри —
// только кэшированные геометрии и материалы: собственных ресурсов аксессуар не создаёт и потому
// не требует индивидуального dispose.

const mesh = (geometry, material, { x = 0, y = 0, z = 0, shadow = true } = {}) => {
  const item = new THREE.Mesh(geometry, material);
  item.position.set(x, y, z);
  item.castShadow = shadow;
  return item;
};

// Метка для аниматора: этой части полагается собственное движение поверх общего.
const tag = (object, role) => {
  object.userData.cosmeticRole = role;
  return object;
};

// ── ТЕЛО ────────────────────────────────────────────────────────────────────────────────────
//
// Body-предметы почти не добавляют геометрии: основной вклад — перекраска корпуса, которую делает
// CosmeticRenderer напрямую по `render.primary/accent/belly`. Здесь собираются только накладки:
// воротники, пояса, слои, рёбра и прочие детали силуэта.

function bodyFeatures(render) {
  const group = new THREE.Group();
  const features = render.features || [];
  const accent = standardMaterial(render.accent ?? 0xffffff);

  if (features.includes('collar')) {
    const collar = mesh(cylinder(0.34, 0.4, 0.11, 12), accent, { y: 1.02, z: -0.02 });
    collar.scale.set(1.05, 1, 0.95);
    group.add(collar);
  }
  if (features.includes('belt')) {
    const belt = mesh(cylinder(0.5, 0.5, 0.12, 14), accent, { y: 0.6 });
    belt.scale.set(1.06, 1, 0.95);
    group.add(belt);
    group.add(mesh(box(0.16, 0.16, 0.06), standardMaterial(render.belly ?? 0xffffff), { y: 0.6, z: -0.47 }));
  }
  if (features.includes('layers')) {
    // Слоями собираются бургер и ролл: три тонких кольца разного цвета вокруг корпуса.
    const colors = [render.accent ?? 0xffffff, render.belly ?? 0xffffff, render.accent ?? 0xffffff];
    colors.forEach((color, index) => {
      const layer = mesh(cylinder(0.5 - index * 0.02, 0.5 - index * 0.02, 0.1, 14), standardMaterial(color), {
        y: 0.98 - index * 0.24
      });
      layer.scale.set(1.04, 1, 0.94);
      group.add(layer);
    });
  }
  if (features.includes('glaze')) {
    const glaze = mesh(sphere(0.5, 14), standardMaterial(render.accent ?? 0xff7fc4, { roughness: 0.18 }), {
      y: 1.05
    });
    glaze.scale.set(1.04, 0.5, 0.96);
    group.add(glaze);
  }
  if (features.includes('sprinkles')) {
    const sprinkle = standardMaterial(render.belly ?? 0xffffff, { roughness: 0.2 });
    for (let index = 0; index < 6; index++) {
      const angle = (index / 6) * Math.PI * 2;
      const chip = mesh(box(0.07, 0.025, 0.025), sprinkle, {
        x: Math.cos(angle) * 0.4,
        y: 1.18,
        z: Math.sin(angle) * 0.36
      });
      chip.rotation.y = angle;
      group.add(chip);
    }
  }
  if (features.includes('ribs')) {
    const bone = standardMaterial(render.accent ?? 0xe8e4d5, { roughness: 0.5 });
    for (let index = 0; index < 3; index++) {
      const rib = mesh(cylinder(0.03, 0.03, 0.62, 6), bone, { y: 0.95 - index * 0.16, z: -0.4 });
      rib.rotation.z = Math.PI / 2;
      group.add(rib);
    }
  }
  if (features.includes('stripes')) {
    const stripe = standardMaterial(render.accent ?? 0xffffff);
    for (const x of [-0.5, 0.5]) {
      const band = mesh(box(0.06, 0.28, 0.2), stripe, { x, y: 0.9 });
      group.add(band);
    }
  }
  return group;
}

function bodyPlates(render) {
  const group = new THREE.Group();
  const panel = standardMaterial(render.panel ?? 0x8492ad, { roughness: 0.42, metalness: 0.3 });
  const chest = mesh(box(0.46, 0.42, 0.1), panel, { y: 0.86, z: -0.44 });
  group.add(chest);
  for (const x of [-0.44, 0.44]) {
    const shoulder = mesh(render.pixel ? box(0.26, 0.16, 0.26) : sphere(0.17, 8), panel, { x, y: 1.02 });
    group.add(shoulder);
  }
  // Экран у ЭЛТ-корпуса: тёмная плоскость с эмиссивной рамкой. Постобработки нет — свечение
  // делается материалом, а не отдельным проходом на игрока.
  if (render.screen) {
    group.add(
      mesh(box(0.34, 0.26, 0.03), standardMaterial(0x0b1512, { roughness: 0.1 }), { y: 0.86, z: -0.5 })
    );
  }
  group.add(tag(mesh(sphere(0.06, 8), glowMaterial(render.glow ?? 0xffd166), { y: 1.02, z: -0.5 }), 'blink'));
  return group;
}

function bodyCreature(render) {
  const group = new THREE.Group();
  const skin = standardMaterial(render.primary ?? 0xffffff);
  const inner = standardMaterial(render.belly ?? 0xffffff);

  if (render.ears === 'point') {
    for (const x of [-0.24, 0.24]) {
      const ear = tag(mesh(cone(0.14, 0.28, 6), skin, { x, y: 1.52 }), 'ear');
      ear.rotation.z = x < 0 ? 0.16 : -0.16;
      ear.add(mesh(cone(0.08, 0.16, 6), inner, { y: 0.02, z: -0.03 }));
      group.add(ear);
    }
  } else if (render.ears === 'stalk') {
    for (const x of [-0.16, 0.16]) {
      const stalk = tag(new THREE.Group(), 'ear');
      stalk.position.set(x, 1.5, 0);
      stalk.add(mesh(cylinder(0.025, 0.03, 0.26, 6), skin, { y: 0.13 }));
      stalk.add(mesh(sphere(0.075, 8), glowMaterial(render.accent ?? 0x7cf9d0), { y: 0.29 }));
      group.add(stalk);
    }
  } else if (render.ears === 'fin') {
    const fin = tag(mesh(cone(0.16, 0.4, 4), standardMaterial(render.accent ?? 0x2b3f57), { y: 1.5 }), 'ear');
    fin.rotation.x = -0.18;
    fin.scale.set(0.45, 1, 1);
    group.add(fin);
  } else if (render.ears === 'tentacle') {
    const count = render.tentacles || 4;
    for (let index = 0; index < count; index++) {
      const angle = (index / count) * Math.PI * 2;
      const arm = tag(new THREE.Group(), 'tentacle');
      arm.position.set(Math.cos(angle) * 0.28, 1.46, Math.sin(angle) * 0.24);
      arm.rotation.z = Math.cos(angle) * 0.4;
      arm.rotation.x = Math.sin(angle) * 0.4;
      arm.add(mesh(capsuleGeometry(0.05, 0.24, 6), skin, { y: 0.16 }));
      arm.add(mesh(sphere(0.05, 6), standardMaterial(render.accent ?? 0x3ad6a0), { y: 0.3 }));
      group.add(arm);
    }
  }

  if (render.muzzle) {
    const muzzle = mesh(sphere(0.19, 10), inner, { y: 1.06, z: -0.5 });
    muzzle.scale.set(1, 0.72, 0.9);
    group.add(muzzle);
    group.add(mesh(sphere(0.05, 6), standardMaterial(0x1b1b26), { y: 1.12, z: -0.66 }));
  }
  if (render.teeth) {
    const tooth = standardMaterial(0xfdfbf4);
    for (const x of [-0.12, 0, 0.12]) {
      const spike = mesh(cone(0.04, 0.1, 4), tooth, { x, y: 0.98, z: -0.56 });
      spike.rotation.x = Math.PI;
      group.add(spike);
    }
  }
  if (render.brow) {
    const brow = standardMaterial(render.accent ?? 0x2f4a1d);
    for (const x of [-0.14, 0.14]) {
      const line = mesh(box(0.16, 0.04, 0.05), brow, { x, y: 1.32, z: -0.48 });
      line.rotation.z = x < 0 ? -0.34 : 0.34;
      group.add(line);
    }
  }
  if (render.tail) {
    const tail = tag(new THREE.Group(), 'tail');
    tail.position.set(0, 0.72, 0.44);
    tail.add(mesh(capsuleGeometry(0.06, 0.34, 6), skin, { y: 0.14, z: 0.08 }));
    group.add(tail);
  }
  return group;
}

function bodyGlow(render) {
  const group = new THREE.Group();
  const glow = glowMaterial(render.glow ?? 0x22e0ff, { intensity: 1.1 });
  const stripes = Math.max(1, render.stripes || 3);
  for (let index = 0; index < stripes; index++) {
    const ring = mesh(torus(0.47, 0.018, 14), glow, { y: 1.12 - index * 0.19 });
    ring.rotation.x = Math.PI / 2;
    ring.scale.set(1.04, 0.95, 1);
    group.add(tag(ring, 'pulse'));
  }
  if (render.gradient) {
    // Градиент делается текстурой на тонкой накладке, а не шейдером на игрока: шейдерный вариант
    // означал бы отдельную программу на каждого носителя предмета.
    const texture = stripeTexture(`synth:${render.glow}:${render.accent}`, (ctx, size) => {
      const gradient = ctx.createLinearGradient(0, 0, 0, size);
      gradient.addColorStop(0, '#ff4fd8');
      gradient.addColorStop(0.55, '#7a3cff');
      gradient.addColorStop(1, '#22e0ff');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    });
    const panel = new THREE.Mesh(
      box(0.5, 0.46, 0.04),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
    );
    panel.position.set(0, 0.9, -0.46);
    // Единственный материал во всей фабрике, который создаётся не из кэша: у него собственная
    // карта. Он помечается, и CosmeticRenderer освобождает его вместе с персонажем.
    panel.userData.ownMaterial = true;
    group.add(panel);
  }
  return group;
}

function bodyMythic(render) {
  const group = new THREE.Group();
  const glow = glowMaterial(render.glow ?? 0xb08bff, { intensity: 1.2 });
  const halo = mesh(torus(0.56, 0.02, 16), glow, { y: 0.9 });
  halo.rotation.x = Math.PI / 2.2;
  group.add(tag(halo, 'orbit-ring'));

  const orbits = Math.max(0, Math.min(4, render.orbits ?? 0));
  for (let index = 0; index < orbits; index++) {
    const particle = tag(new THREE.Group(), 'orbit');
    particle.userData.orbitPhase = (index / Math.max(1, orbits)) * Math.PI * 2;
    particle.userData.orbitRadius = 0.62 + (index % 2) * 0.1;
    particle.userData.orbitHeight = 0.85 + (index % 3) * 0.16;
    particle.add(mesh(sphere(0.05, 6), glow, {}, false));
    group.add(particle);
  }
  if (render.effect === 'glitch') {
    // «Сдвиг картинки» — две тонкие цветные накладки, которые аниматор изредка смещает по X.
    // Никакого пост-эффекта на игрока: он стоил бы отдельного прохода на каждого носителя.
    for (const [offset, color] of [
      [-0.03, render.accent ?? 0x22e0ff],
      [0.03, render.glow ?? 0xff3b6b]
    ]) {
      const shard = mesh(box(0.52, 0.2, 0.02), translucentMaterial(color, 0.4), {
        x: offset,
        y: 1,
        z: -0.5
      });
      group.add(tag(shard, 'glitch'));
    }
  }
  if (render.effect === 'abyss') {
    const ripple = mesh(torus(0.44, 0.014, 14), glow, { y: 0.14 });
    ripple.rotation.x = Math.PI / 2;
    group.add(tag(ripple, 'ripple'));
  }
  return group;
}

// ── ГОЛОВА ──────────────────────────────────────────────────────────────────────────────────

function headAntenna(render) {
  const group = new THREE.Group();
  const color = render.primary ?? 0xffde59;
  const stemMaterial = standardMaterial(color);
  group.add(mesh(cylinder(0.035, 0.045, 0.22, 7), stemMaterial, { y: 0.11 }));
  const tipMaterial = render.holo
    ? translucentMaterial(render.secondary ?? color, 0.6)
    : standardMaterial(color, { roughness: 0.2 });
  group.add(mesh(sphere(0.09, 8), tipMaterial, { y: 0.25 }));
  if (render.holo) {
    const ring = mesh(torus(0.13, 0.012, 12), translucentMaterial(render.secondary ?? color, 0.5), {
      y: 0.25
    });
    ring.rotation.x = Math.PI / 2;
    group.add(tag(ring, 'pulse'));
  }
  return group;
}

function headDish(render) {
  const group = new THREE.Group();
  const body = standardMaterial(render.secondary ?? 0x5b7bb8, { metalness: 0.35, roughness: 0.4 });
  group.add(mesh(cylinder(0.04, 0.05, 0.2, 7), body, { y: 0.1 }));
  const dish = new THREE.Group();
  dish.position.y = 0.26;
  dish.rotation.x = -0.6;
  const plate = mesh(cone(0.21, 0.1, 14), standardMaterial(render.primary ?? 0xdfe7f5, { roughness: 0.35 }));
  plate.rotation.x = Math.PI;
  dish.add(plate);
  dish.add(mesh(cylinder(0.014, 0.014, 0.16, 5), body, { y: -0.09 }));
  dish.add(mesh(sphere(0.035, 6), standardMaterial(render.secondary ?? 0x5b7bb8), { y: -0.17 }));
  group.add(tag(dish, 'swing'));
  return group;
}

function headCrown(render) {
  const group = new THREE.Group();
  const points = Math.max(2, render.points || 3);
  const base = standardMaterial(render.secondary ?? render.primary ?? 0xffd76a);
  const ring = mesh(cylinder(0.28, 0.3, 0.07, 12), base, { y: 0.04 });
  group.add(ring);

  for (let index = 0; index < points; index++) {
    const angle = -Math.PI / 2 + ((index + 0.5) / points) * Math.PI * 1.55 - Math.PI * 0.28;
    const spike = tag(new THREE.Group(), 'spike');
    spike.userData.spikeIndex = index;
    spike.position.set(Math.cos(angle) * 0.24, 0.08, Math.sin(angle) * 0.24);

    if (render.style === 'star') {
      const star = mesh(
        starGeometry(0.11),
        standardMaterial(render.primary ?? 0xffd76a, { roughness: 0.22 }),
        {
          y: 0.14
        }
      );
      star.rotation.y = angle;
      spike.add(star);
      spike.add(mesh(cylinder(0.012, 0.012, 0.14, 5), base, { y: 0.05 }));
    } else if (render.style === 'fries') {
      const stick = mesh(box(0.055, 0.3, 0.055), standardMaterial(render.primary ?? 0xffd257), { y: 0.16 });
      stick.rotation.z = (index - points / 2) * 0.09;
      spike.add(stick);
    } else if (render.style === 'pixel') {
      for (let step = 0; step < 3; step++) {
        spike.add(
          mesh(box(0.09, 0.09, 0.09), standardMaterial(render.primary ?? 0x22e0ff), {
            y: 0.06 + step * 0.09,
            z: step * 0.01
          })
        );
      }
    } else {
      spike.add(mesh(cone(0.07, 0.24, 6), standardMaterial(render.primary ?? 0xffd76a), { y: 0.14 }));
    }
    group.add(spike);
  }
  return group;
}

function headFin(render) {
  const group = new THREE.Group();
  const fin = mesh(cone(0.14, 0.42, 4), standardMaterial(render.primary ?? 0xff5f6d), { y: 0.2 });
  fin.scale.set(0.32, 1, 1.1);
  group.add(fin);
  const stripe = mesh(box(0.03, 0.3, 0.16), standardMaterial(render.secondary ?? 0xfff0f2), {
    y: 0.2,
    z: 0.02
  });
  group.add(stripe);
  return group;
}

function headHat(render) {
  const group = new THREE.Group();
  if (render.style === 'chef') {
    const cloth = standardMaterial(render.primary ?? 0xfbfaf6, { roughness: 0.62 });
    group.add(
      mesh(cylinder(0.27, 0.29, 0.14, 12), standardMaterial(render.secondary ?? 0xe3ddcc), { y: 0.06 })
    );
    const puff = tag(new THREE.Group(), 'swing');
    puff.position.y = 0.14;
    for (const [x, z, r, y] of [
      [0, 0, 0.24, 0.18],
      [-0.15, 0.05, 0.16, 0.1],
      [0.15, -0.05, 0.17, 0.12],
      [0.03, -0.16, 0.14, 0.09]
    ]) {
      puff.add(mesh(sphere(r, 10), cloth, { x, y, z }));
    }
    group.add(puff);
    return group;
  }
  // Треуголка: широкие поля + низкая тулья + перо.
  const felt = standardMaterial(render.primary ?? 0x2a2f3d, { roughness: 0.65 });
  const brim = mesh(cone(0.42, 0.1, 3), felt, { y: 0.06 });
  brim.rotation.y = Math.PI / 6;
  brim.scale.y = 0.6;
  group.add(brim);
  group.add(mesh(sphere(0.24, 10), felt, { y: 0.11 }));
  group.add(mesh(cylinder(0.25, 0.25, 0.04, 10), standardMaterial(render.secondary ?? 0xf0d98a), { y: 0.1 }));
  const feather = tag(
    mesh(cone(0.045, 0.3, 5), standardMaterial(render.secondary ?? 0xf0d98a), {
      x: 0.19,
      y: 0.24,
      z: 0.06
    }),
    'swing'
  );
  feather.rotation.z = -0.5;
  group.add(feather);
  return group;
}

function headHorns(render) {
  const group = new THREE.Group();
  const material = glowMaterial(render.primary ?? 0xff4fd8, { intensity: 1.15 });
  const root = standardMaterial(render.secondary ?? 0x2a1050);
  for (const x of [-0.19, 0.19]) {
    const horn = tag(new THREE.Group(), 'ear');
    horn.position.set(x, 0.02, 0);
    horn.rotation.z = x < 0 ? 0.34 : -0.34;
    horn.add(mesh(cylinder(0.05, 0.06, 0.06, 6), root, { y: 0.02 }));
    horn.add(mesh(cone(0.05, 0.24, 6), material, { y: 0.16 }));
    group.add(horn);
  }
  return group;
}

function headPerch(render) {
  const group = new THREE.Group();
  const perch = tag(new THREE.Group(), 'perch');
  perch.position.set(0.12, 0.1, 0.02);
  const feather = standardMaterial(render.primary ?? 0xe0453c);
  const wing = standardMaterial(render.secondary ?? 0x3ad6a0);
  const bodyMesh = mesh(sphere(0.14, 10), feather, { y: 0.1 });
  bodyMesh.scale.set(0.85, 1.05, 0.95);
  perch.add(bodyMesh);
  perch.add(mesh(sphere(0.09, 8), feather, { y: 0.24, z: -0.04 }));
  perch.add(mesh(cone(0.045, 0.1, 5), standardMaterial(render.accent ?? 0xf7d94b), { y: 0.23, z: -0.14 }));
  const tail = mesh(box(0.06, 0.03, 0.2), wing, { y: 0.06, z: 0.16 });
  perch.add(tag(tail, 'tail'));
  for (const x of [-0.11, 0.11]) {
    const side = mesh(box(0.04, 0.14, 0.12), wing, { x, y: 0.11 });
    perch.add(side);
  }
  perch.add(mesh(sphere(0.028, 6), standardMaterial(0x14161f), { x: 0.05, y: 0.26, z: -0.1 }));
  group.add(perch);
  return group;
}

// ── ЛИЦО ────────────────────────────────────────────────────────────────────────────────────
//
// `face-plate` намеренно не строит геометрию: это унаследованный визор, и его вид задаётся
// перекраской базовой детали персонажа. Так старые предметы выглядят ровно как раньше.

function faceShades(render) {
  const group = new THREE.Group();
  const frame = standardMaterial(render.primary ?? 0x140b2b, { roughness: 0.2, metalness: 0.2 });
  const lens = render.laser
    ? glowMaterial(render.secondary ?? 0xff3b6b, { intensity: 1.3 })
    : standardMaterial(render.secondary ?? 0x2a0d0a, { roughness: 0.08, metalness: 0.35 });
  group.add(mesh(box(0.44, 0.13, 0.06), frame, { y: 0.01, z: -0.01 }));
  if (render.laser) {
    group.add(mesh(box(0.4, 0.045, 0.04), lens, { y: 0.01, z: -0.05 }));
  } else {
    for (const x of [-0.11, 0.11]) group.add(mesh(box(0.17, 0.1, 0.04), lens, { x, y: 0.01, z: -0.05 }));
    group.add(mesh(box(0.06, 0.03, 0.04), frame, { y: 0.01, z: -0.05 }));
  }
  for (const x of [-0.23, 0.23]) {
    const arm = mesh(box(0.04, 0.03, 0.18), frame, { x, y: 0.01, z: 0.08 });
    group.add(arm);
  }
  return group;
}

function faceEyes(render) {
  const group = new THREE.Group();
  const shell = standardMaterial(render.secondary ?? 0x7cf9d0, { roughness: 0.15 });
  const pupil = standardMaterial(render.primary ?? 0x0d0f24, { roughness: 0.1 });
  for (const x of [-0.15, 0.15]) {
    const eye = mesh(sphere(0.14, 12), shell, { x, y: 0.02, z: -0.04 });
    eye.scale.set(1, 1.25, 0.7);
    eye.add(mesh(sphere(0.06, 8), pupil, { z: -0.09 }));
    group.add(eye);
  }
  return group;
}

function facePatch(render) {
  const group = new THREE.Group();
  const patch = mesh(
    box(0.17, 0.15, 0.05),
    standardMaterial(render.primary ?? 0x14161f, { roughness: 0.7 }),
    {
      x: -0.12,
      y: 0.03,
      z: -0.05
    }
  );
  group.add(patch);
  const strap = mesh(box(0.56, 0.035, 0.03), standardMaterial(render.secondary ?? 0x3a3f52), {
    y: 0.09,
    z: 0.01
  });
  strap.rotation.z = 0.2;
  group.add(strap);
  return group;
}

function faceScan(render) {
  const group = new THREE.Group();
  const plate = mesh(
    box(0.42, 0.24, 0.05),
    standardMaterial(render.primary ?? 0x0d1a24, { roughness: 0.12 }),
    {
      y: 0.01,
      z: -0.03
    }
  );
  group.add(plate);
  const line = mesh(box(0.4, 0.03, 0.035), glowMaterial(render.secondary ?? 0x3ad6a0, { intensity: 1.4 }), {
    y: 0.08,
    z: -0.06
  });
  group.add(tag(line, 'scan'));
  return group;
}

function faceNebula(render) {
  const group = new THREE.Group();
  const glass = mesh(sphere(0.3, 14), translucentMaterial(render.primary ?? 0x8f6bff, 0.55), { z: -0.02 });
  glass.scale.set(1, 0.6, 0.24);
  group.add(glass);
  const swirl = mesh(torus(0.16, 0.03, 12), translucentMaterial(render.secondary ?? 0x6cf7ff, 0.7), {
    z: -0.06
  });
  swirl.scale.set(1, 0.6, 0.6);
  group.add(tag(swirl, 'swirl'));
  return group;
}

// ── СПИНА ───────────────────────────────────────────────────────────────────────────────────

function backTanks(render) {
  const group = new THREE.Group();
  const shell = standardMaterial(render.primary ?? 0xe8eefb, { metalness: 0.2, roughness: 0.35 });
  const cap = standardMaterial(render.secondary ?? 0x4f8cff);
  const count = Math.max(1, Math.min(3, render.count || 2));
  const spread = count === 1 ? [0] : count === 2 ? [-0.14, 0.14] : [-0.2, 0, 0.2];
  for (const x of spread) {
    group.add(mesh(cylinder(0.09, 0.09, 0.42, 10), shell, { x, y: 0.02 }));
    group.add(mesh(sphere(0.09, 8), cap, { x, y: 0.23 }));
    if (render.nozzle) group.add(mesh(cone(0.05, 0.1, 6), cap, { x, y: 0.31 }));
  }
  group.add(mesh(box(0.34, 0.1, 0.08), cap, { y: 0.06, z: -0.09 }));
  return group;
}

function backCrate(render) {
  const group = new THREE.Group();
  const shell = standardMaterial(render.primary ?? 0x7c4a24, { roughness: 0.5 });
  const trim = standardMaterial(render.secondary ?? 0xf0d98a, { metalness: 0.25, roughness: 0.3 });

  if (render.style === 'chest') {
    group.add(mesh(box(0.42, 0.26, 0.28), shell, { y: -0.02 }));
    const lid = tag(mesh(box(0.44, 0.14, 0.3), shell, { y: 0.15 }), 'lid');
    lid.add(mesh(box(0.46, 0.04, 0.06), trim, { y: 0 }));
    group.add(lid);
    group.add(mesh(box(0.08, 0.1, 0.05), trim, { y: 0.06, z: -0.16 }));
    return group;
  }
  if (render.style === 'battery') {
    group.add(mesh(box(0.36, 0.44, 0.24), shell, {}));
    for (let index = 0; index < 3; index++) {
      group.add(
        mesh(box(0.2, 0.05, 0.03), glowMaterial(render.secondary ?? 0x3aff9e, { intensity: 1.2 }), {
          y: 0.12 - index * 0.11,
          z: -0.14
        })
      );
    }
    group.add(mesh(cylinder(0.05, 0.05, 0.06, 8), trim, { y: 0.25 }));
    return group;
  }
  // Тостер: корпус, щель и тост, который иногда выпрыгивает.
  group.add(mesh(box(0.4, 0.34, 0.26), standardMaterial(render.primary ?? 0xd8dde8, { metalness: 0.4 }), {}));
  group.add(mesh(box(0.3, 0.03, 0.14), standardMaterial(0x2a2f3d), { y: 0.18 }));
  const toast = tag(
    mesh(box(0.24, 0.22, 0.06), standardMaterial(render.secondary ?? 0xe8a447), { y: 0.14 }),
    'toast'
  );
  toast.userData.restY = 0.14;
  group.add(toast);
  group.add(mesh(box(0.06, 0.12, 0.05), standardMaterial(0x2a2f3d), { x: 0.22, y: 0.02, z: -0.06 }));
  return group;
}

function backBarrel(render) {
  const group = new THREE.Group();
  const wood = standardMaterial(render.primary ?? 0x9c6b3a, { roughness: 0.62 });
  const hoop = standardMaterial(render.secondary ?? 0x5c4326, { metalness: 0.3, roughness: 0.4 });
  const barrel = mesh(cylinder(0.17, 0.17, 0.4, 12), wood, {});
  barrel.rotation.z = Math.PI / 2;
  group.add(barrel);
  for (const x of [-0.12, 0.12]) {
    const ring = mesh(torus(0.175, 0.018, 12), hoop, { x });
    ring.rotation.y = Math.PI / 2;
    group.add(ring);
  }
  return group;
}

// ── ЭМОЦИИ: реквизит ────────────────────────────────────────────────────────────────────────

function emoteProp(render) {
  const group = new THREE.Group();
  if (render.prop === 'telescope') {
    const brass = standardMaterial(0xd8a63a, { metalness: 0.5, roughness: 0.3 });
    const tube = mesh(cylinder(0.05, 0.07, 0.34, 10), brass, {});
    tube.rotation.x = Math.PI / 2;
    group.add(tube);
    group.add(mesh(cylinder(0.04, 0.04, 0.14, 8), standardMaterial(0x2a2f3d), { z: -0.2 }));
  }
  return group;
}

// ── Реестр ──────────────────────────────────────────────────────────────────────────────────

export const RENDER_KIND_BUILDERS = Object.freeze({
  'body-suit': bodyFeatures,
  'body-plated': bodyPlates,
  'body-creature': bodyCreature,
  'body-glow': bodyGlow,
  'body-mythic': bodyMythic,

  'head-antenna': headAntenna,
  'head-dish': headDish,
  'head-crown': headCrown,
  'head-fin': headFin,
  'head-hat': headHat,
  'head-horns': headHorns,
  'head-perch': headPerch,

  // Унаследованный визор — перекраска базовой детали, собственной геометрии у него нет.
  'face-plate': () => new THREE.Group(),
  'face-shades': faceShades,
  'face-eyes': faceEyes,
  'face-patch': facePatch,
  'face-scan': faceScan,
  'face-nebula': faceNebula,

  'back-tanks': backTanks,
  'back-crate': backCrate,
  'back-barrel': backBarrel,

  // Следы, финиши и эмоции строятся собственными системами: у них жизненный цикл, а не статичная
  // модель. Реестр всё равно обязан их знать — иначе валидатор каталога и реестр разойдутся.
  'particle-trail': () => new THREE.Group(),
  'jet-trail': () => new THREE.Group(),
  'ghost-trail': () => new THREE.Group(),
  'finish-glyph': () => new THREE.Group(),
  'finish-portal': () => new THREE.Group(),
  'finish-burst': () => new THREE.Group(),
  'finish-cannon': () => new THREE.Group(),
  'emote-pose': emoteProp
});

/**
 * Собирает аксессуар по описанию предмета. Неизвестный kind возвращает пустую группу, а не бросает:
 * потерянная деталь на персонаже — плохо, упавший кадр — хуже.
 */
export function buildAccessory(item) {
  const builder = RENDER_KIND_BUILDERS[item?.render?.kind];
  if (!builder) return new THREE.Group();
  const group = builder(item.render);
  group.userData.cosmeticId = item.id;
  return group;
}
