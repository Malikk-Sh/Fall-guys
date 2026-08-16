import * as THREE from 'three';

// Общие геометрии и материалы косметики.
//
// В полной комнате шестнадцать персонажей, и у каждого до пяти надетых предметов. Если каждый
// предмет создаёт собственные BoxGeometry и MeshStandardMaterial, получается под сотню объектов,
// половина из которых побайтово одинакова, — и столько же отдельных шейдерных программ и буферов
// на видеокарте. Поэтому и форма, и материал берутся из кэша по ключу: одинаковые предметы у
// разных игроков разделяют одни и те же ресурсы.
//
// Кэш живёт столько же, сколько страница, и намеренно не выбрасывается вместе с персонажем: иначе
// уход одного игрока освобождал бы геометрию, которой пользуются оставшиеся. Освобождается он
// целиком — при смене сцены (см. dispose).

const GEOMETRIES = new Map();
const MATERIALS = new Map();
const TEXTURES = new Map();

export function cachedGeometry(key, build) {
  let geometry = GEOMETRIES.get(key);
  if (!geometry) {
    geometry = build();
    GEOMETRIES.set(key, geometry);
  }
  return geometry;
}

export function cachedMaterial(key, build) {
  let material = MATERIALS.get(key);
  if (!material) {
    material = build();
    MATERIALS.set(key, material);
  }
  return material;
}

export function cachedTexture(key, build) {
  let texture = TEXTURES.get(key);
  if (!texture) {
    texture = build();
    TEXTURES.set(key, texture);
  }
  return texture;
}

// ── Геометрические примитивы ────────────────────────────────────────────────────────────────
// Округлость и малое число сегментов — сознательный выбор: на телефоне читается силуэт, а не
// количество треугольников, а каждый лишний сегмент умножается на число игроков в комнате.

export const box = (w, h, d) => cachedGeometry(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d));

export const sphere = (r, seg = 10) =>
  cachedGeometry(`sph:${r}:${seg}`, () => new THREE.SphereGeometry(r, seg, Math.max(6, seg - 3)));

export const cylinder = (rTop, rBottom, h, seg = 10) =>
  cachedGeometry(
    `cyl:${rTop}:${rBottom}:${h}:${seg}`,
    () => new THREE.CylinderGeometry(rTop, rBottom, h, seg)
  );

export const cone = (r, h, seg = 8) =>
  cachedGeometry(`cone:${r}:${h}:${seg}`, () => new THREE.ConeGeometry(r, h, seg));

export const capsuleGeometry = (r, len, seg = 8) =>
  cachedGeometry(`cap:${r}:${len}:${seg}`, () => new THREE.CapsuleGeometry(r, len, 4, seg));

export const torus = (r, tube, seg = 10) =>
  cachedGeometry(`tor:${r}:${tube}:${seg}`, () => new THREE.TorusGeometry(r, tube, 6, seg));

// Плоская пятиконечная звезда. Строится из формы один раз и дальше переиспользуется всеми
// звёздными предметами — а их в каталоге несколько.
export const starGeometry = (radius = 0.12) =>
  cachedGeometry(`star:${radius}`, () => {
    const shape = new THREE.Shape();
    const inner = radius * 0.44;
    for (let i = 0; i < 10; i++) {
      const angle = (Math.PI / 5) * i - Math.PI / 2;
      const r = i % 2 === 0 ? radius : inner;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, { depth: radius * 0.22, bevelEnabled: false });
  });

// ── Материалы ───────────────────────────────────────────────────────────────────────────────

export function standardMaterial(color, { roughness = 0.32, metalness = 0.04 } = {}) {
  return cachedMaterial(
    `std:${color}:${roughness}:${metalness}`,
    () => new THREE.MeshStandardMaterial({ color, roughness, metalness })
  );
}

export function glowMaterial(color, { emissive = color, intensity = 0.9 } = {}) {
  return cachedMaterial(
    `glow:${color}:${emissive}:${intensity}`,
    () =>
      new THREE.MeshStandardMaterial({
        color,
        emissive,
        emissiveIntensity: intensity,
        roughness: 0.42,
        metalness: 0.06
      })
  );
}

export function translucentMaterial(color, opacity = 0.55) {
  return cachedMaterial(
    `tr:${color}:${opacity}`,
    () =>
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.55,
        transparent: true,
        opacity,
        depthWrite: false,
        roughness: 0.2
      })
  );
}

export function basicMaterial(color, opacity = 1) {
  return cachedMaterial(
    `basic:${color}:${opacity}`,
    () =>
      new THREE.MeshBasicMaterial({
        color,
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity >= 1
      })
  );
}

// Лёгкая процедурная текстура. Внешних текстурных паков в проекте нет и заводить их ради косметики
// нельзя — «десятки мегабайт обязательных текстур» прямо противоречат мобильному вебу. Канвас
// 64×64 стоит доли миллисекунды и кэшируется по ключу.
export function stripeTexture(key, paint, size = 64) {
  return cachedTexture(`tex:${key}`, () => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    paint(canvas.getContext('2d'), size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  });
}

/**
 * Полное освобождение кэша. Вызывать только при уходе со страницы или полной пересборке сцены:
 * во время игры общие ресурсы обязаны пережить любого отдельного персонажа.
 */
export function disposeCosmeticResources() {
  for (const geometry of GEOMETRIES.values()) geometry.dispose();
  for (const material of MATERIALS.values()) material.dispose();
  for (const texture of TEXTURES.values()) texture.dispose();
  GEOMETRIES.clear();
  MATERIALS.clear();
  TEXTURES.clear();
}

export function cosmeticResourceStats() {
  return { geometries: GEOMETRIES.size, materials: MATERIALS.size, textures: TEXTURES.size };
}
