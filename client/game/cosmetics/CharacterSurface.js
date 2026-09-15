import * as THREE from 'three';
import { cachedTexture } from './CosmeticResources.js';

export const SURFACE_PROFILES = Object.freeze({
  fabric: { roughness: 0.68, metalness: 0.02, clearcoat: 0.08, strength: 0.09 },
  ceramic: { roughness: 0.3, metalness: 0.14, clearcoat: 0.55, strength: 0.055 },
  metal: { roughness: 0.34, metalness: 0.68, clearcoat: 0.22, strength: 0.045 },
  plush: { roughness: 0.92, metalness: 0, clearcoat: 0, strength: 0.14 },
  pastry: { roughness: 0.76, metalness: 0, clearcoat: 0, strength: 0.12 }
});

// Periodic height fields give materials actual light response. Shared 128px normal maps
// require no downloads, per-character textures or displacement of the gameplay shape.
export function surfaceHeight(kind, u, v) {
  const tau = Math.PI * 2;
  if (kind === 'fabric')
    return Math.sin(u * tau * 16) * Math.sin(v * tau * 16) * 0.65 + Math.cos((u + v) * tau * 32) * 0.16;
  if (kind === 'metal') return Math.sin(v * tau * 48) * 0.4 + Math.cos(u * tau * 8) * 0.07;
  if (kind === 'plush')
    return Math.sin(u * tau * 24 + Math.sin(v * tau * 8)) * 0.4 + Math.cos((u - v) * tau * 32) * 0.25;
  if (kind === 'pastry')
    return Math.sin(u * tau * 13) * Math.cos(v * tau * 17) * 0.45 + Math.sin((u + v) * tau * 29) * 0.2;
  return Math.sin(u * tau * 24) * Math.cos(v * tau * 24) * 0.12;
}

export function surfaceNormalMap(kind = 'fabric') {
  const resolved = Object.hasOwn(SURFACE_PROFILES, kind) ? kind : 'fabric';
  return cachedTexture(`surface-normal-v1:${resolved}`, () => {
    const size = 128;
    const pixels = new Uint8Array(size * size * 4);
    const step = 1 / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size,
          v = y / size;
        const nx = surfaceHeight(resolved, u - step, v) - surfaceHeight(resolved, u + step, v);
        const ny = surfaceHeight(resolved, u, v - step) - surfaceHeight(resolved, u, v + step);
        const inverseLength = 1 / Math.hypot(nx, ny, 1);
        const offset = (y * size + x) * 4;
        pixels[offset] = Math.round((nx * inverseLength * 0.5 + 0.5) * 255);
        pixels[offset + 1] = Math.round((ny * inverseLength * 0.5 + 0.5) * 255);
        pixels[offset + 2] = Math.round((inverseLength * 0.5 + 0.5) * 255);
        pixels[offset + 3] = 255;
      }
    }
    const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(resolved === 'metal' ? 1 : 2, 2);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
  });
}

export function applySurface(material, kind = 'fabric') {
  const profile = SURFACE_PROFILES[kind] || SURFACE_PROFILES.fabric;
  material.roughness = profile.roughness;
  material.metalness = profile.metalness;
  material.clearcoat = profile.clearcoat;
  material.clearcoatRoughness = 0.3;
  material.normalMap = surfaceNormalMap(kind);
  material.normalScale.setScalar(profile.strength);
  material.needsUpdate = true;
}
