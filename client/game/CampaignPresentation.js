import * as THREE from 'three';

const DEFAULT_SCENE = Object.freeze({
  background: 0x83dff0,
  fog: 0x93e5ef,
  fogNear: 42,
  fogFar: 145,
  sun: 0xfff7dc,
  sunIntensity: 2.85,
  exposure: 1.08
});

export const CAMPAIGN_THEMES = Object.freeze({
  'cloud-factory': Object.freeze({
    id: 'cloud-factory',
    world: 'CLOUD FACTORY',
    background: 0x8dddeb,
    fog: 0xa9e9ef,
    fogNear: 48,
    fogFar: 156,
    sun: 0xfff4d6,
    sunIntensity: 2.9,
    exposure: 1.08,
    accent: 0xffd54d,
    secondary: 0x5fe6ff
  }),
  'storm-zone': Object.freeze({
    id: 'storm-zone',
    world: 'STORM ZONE',
    background: 0x263653,
    fog: 0x31435f,
    fogNear: 28,
    fogFar: 116,
    sun: 0xbfd7ff,
    sunIntensity: 2.15,
    exposure: 0.92,
    accent: 0x8ddcff,
    secondary: 0x8c7bff
  }),
  reactor: Object.freeze({
    id: 'reactor',
    world: 'REACTOR',
    background: 0x091526,
    fog: 0x10283b,
    fogNear: 34,
    fogFar: 126,
    sun: 0xa6f5ff,
    sunIntensity: 2.2,
    exposure: 1.0,
    accent: 0x4dffcf,
    secondary: 0x45bfff
  }),
  collapse: Object.freeze({
    id: 'collapse',
    world: 'COLLAPSE',
    background: 0x211318,
    fog: 0x3a2022,
    fogNear: 24,
    fogFar: 104,
    sun: 0xffb06b,
    sunIntensity: 2.45,
    exposure: 0.94,
    accent: 0xff704d,
    secondary: 0xffc45a
  })
});

export function campaignChapterNumber(chapterId) {
  const match = /^ch(\d+)$/.exec(String(chapterId || ''));
  return match ? Number(match[1]) : null;
}

export function campaignThemeFor(chapterId) {
  const chapter = campaignChapterNumber(chapterId);
  if (!chapter || chapter > 10) return null;
  if (chapter <= 3) return CAMPAIGN_THEMES['cloud-factory'];
  if (chapter <= 6) return CAMPAIGN_THEMES['storm-zone'];
  if (chapter <= 9) return CAMPAIGN_THEMES.reactor;
  return CAMPAIGN_THEMES.collapse;
}

const vectorFrom = position =>
  position ? new THREE.Vector3(position.x || 0, position.y || 0, position.z || 0) : new THREE.Vector3();

const disposeObject = object => {
  if (!object) return;
  const geometries = new Set();
  const materials = new Set();
  object.traverse(child => {
    if (child.geometry) geometries.add(child.geometry);
    if (Array.isArray(child.material)) child.material.forEach(material => materials.add(material));
    else if (child.material) materials.add(child.material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
};

const setEmissive = (object, intensity) => {
  object?.traverse(child => {
    if (child.material?.emissive) child.material.emissiveIntensity = intensity;
  });
};

const velocityLength = velocity => Math.hypot(velocity?.x || 0, velocity?.y || 0, velocity?.z || 0);

class CampaignPresentation {
  constructor({
    getGame = () => globalThis.__WOBBLE_GAME__,
    requestFrame = globalThis.requestAnimationFrame?.bind(globalThis),
    cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis)
  } = {}) {
    this.getGame = getGame;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.frame = null;
    this.course = null;
    this.theme = null;
    this.worldGroup = null;
    this.rain = null;
    this.reactorMaterial = null;
    this.beaconMaterial = null;
    this.lastCore = null;
    this.lastSignal = null;
    this.lastThrow = null;
    this.lastTrailAt = 0;
    this.finalSurge = false;
    this.lastAt = 0;
    this.bannerTimer = null;
    this.banner = null;
    this.started = false;
  }

  start() {
    if (this.started || !this.requestFrame) return;
    this.started = true;
    const loop = now => {
      if (!this.started) return;
      this.tick(now);
      this.frame = this.requestFrame(loop);
    };
    this.frame = this.requestFrame(loop);
  }

  stop() {
    this.started = false;
    if (this.frame !== null && this.cancelFrame) this.cancelFrame(this.frame);
    this.frame = null;
    this.detach(this.getGame());
  }

  tick(now = globalThis.performance?.now?.() ?? Date.now()) {
    const game = this.getGame();
    const course = game?.mode === 'coop' && game.course?.spec?.chapterId ? game.course : null;

    if (course !== this.course) this.attach(game, course);
    if (!course || !game) {
      this.lastAt = now;
      return;
    }

    const dt = this.lastAt ? Math.min(0.05, Math.max(0, (now - this.lastAt) / 1000)) : 0;
    this.lastAt = now;
    this.animateWorld(game, dt, now);
    this.updateCore(game, now);
    this.updateSignal(game);
    this.updateFinale(game);
  }

  attach(game, course) {
    this.detach(game, false);
    this.course = course;
    if (!course || !game) {
      this.restoreScene(game);
      return;
    }

    this.theme = campaignThemeFor(course.spec.chapterId);
    if (!this.theme) return;

    this.applyScene(game, this.theme);
    this.buildWorld(course, this.theme);
    this.showChapterBanner(course.spec, this.theme);
    this.lastCore = null;
    this.lastSignal = null;
    this.lastThrow = null;
    this.finalSurge = false;
    this.lastAt = 0;

    game.postFX?.pulse?.(0.42);
  }

  detach(game, clearCourse = true) {
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = null;
    if (this.banner) this.banner.root.classList.add('hidden');

    if (this.worldGroup) {
      this.worldGroup.parent?.remove(this.worldGroup);
      disposeObject(this.worldGroup);
    }

    this.worldGroup = null;
    this.rain = null;
    this.reactorMaterial = null;
    this.beaconMaterial = null;
    this.theme = null;
    this.lastCore = null;
    this.lastSignal = null;
    this.lastThrow = null;
    this.finalSurge = false;
    if (clearCourse) this.course = null;
    this.restoreScene(game);
  }

  applyScene(game, theme) {
    if (game.scene?.background?.setHex) game.scene.background.setHex(theme.background);
    if (game.scene?.fog?.color?.setHex) {
      game.scene.fog.color.setHex(theme.fog);
      game.scene.fog.near = theme.fogNear;
      game.scene.fog.far = theme.fogFar;
    }
    if (game.sun?.color?.setHex) {
      game.sun.color.setHex(theme.sun);
      game.sun.intensity = theme.sunIntensity;
    }
    if (game.renderer) game.renderer.toneMappingExposure = theme.exposure;
  }

  restoreScene(game) {
    if (!game) return;
    if (game.scene?.background?.setHex) game.scene.background.setHex(DEFAULT_SCENE.background);
    if (game.scene?.fog?.color?.setHex) {
      game.scene.fog.color.setHex(DEFAULT_SCENE.fog);
      game.scene.fog.near = DEFAULT_SCENE.fogNear;
      game.scene.fog.far = DEFAULT_SCENE.fogFar;
    }
    if (game.sun?.color?.setHex) {
      game.sun.color.setHex(DEFAULT_SCENE.sun);
      game.sun.intensity = DEFAULT_SCENE.sunIntensity;
    }
    if (game.renderer) game.renderer.toneMappingExposure = DEFAULT_SCENE.exposure;
  }

  buildWorld(course, theme) {
    const group = new THREE.Group();
    group.name = `campaign-${theme.id}`;
    course.group.add(group);
    this.worldGroup = group;

    if (theme.id === 'cloud-factory') this.buildFactory(group, course, theme);
    else if (theme.id === 'storm-zone') this.buildStorm(group, course, theme);
    else if (theme.id === 'reactor') this.buildReactor(group, course, theme);
    else this.buildCollapse(group, course, theme);
  }

  buildFactory(group, course, theme) {
    const geometry = new THREE.BoxGeometry(2.4, 1, 2.4);
    const material = new THREE.MeshStandardMaterial({
      color: theme.secondary,
      roughness: 0.45,
      metalness: 0.08
    });
    const count = course.quality === 'low' ? 8 : 16;
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const dummy = new THREE.Object3D();
    const span = Math.abs(course.spec.finishZ) + 20;

    for (let index = 0; index < count; index++) {
      const side = index % 2 ? -1 : 1;
      const height = 2.5 + (index % 4) * 1.4;
      dummy.position.set(
        side * (15 + (index % 3) * 5),
        -1 + height / 2,
        8 - ((index * 17) % span)
      );
      dummy.scale.set(1 + (index % 2) * 0.4, height, 1 + (index % 3) * 0.25);
      dummy.rotation.y = (index % 4) * 0.22;
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  buildStorm(group, course, theme) {
    const count = course.quality === 'low' ? 90 : 220;
    const positions = new Float32Array(count * 3);
    const span = Math.abs(course.spec.finishZ) + 35;

    for (let index = 0; index < count; index++) {
      positions[index * 3] = -22 + ((index * 37) % 440) / 10;
      positions[index * 3 + 1] = -4 + ((index * 19) % 260) / 10;
      positions[index * 3 + 2] = 18 - ((index * 29) % Math.round(span * 10)) / 10;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: theme.accent,
      size: course.quality === 'low' ? 0.07 : 0.09,
      transparent: true,
      opacity: 0.55,
      depthWrite: false
    });
    const points = new THREE.Points(geometry, material);
    group.add(points);
    this.rain = { points, positions, count };
  }

  buildReactor(group, course, theme) {
    const length = Math.abs(course.spec.finishZ) + 20;
    const z = (course.spec.finishZ + 12) / 2;
    this.reactorMaterial = new THREE.MeshStandardMaterial({
      color: theme.accent,
      emissive: theme.accent,
      emissiveIntensity: 1.1,
      roughness: 0.22,
      metalness: 0.16
    });

    for (const x of [-6.3, 6.3]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.12, length),
        this.reactorMaterial
      );
      rail.position.set(x, 0.7, z);
      group.add(rail);
    }

    const pylonGeometry = new THREE.BoxGeometry(0.75, 4.2, 0.75);
    const count = course.quality === 'low' ? 8 : 14;
    const pylons = new THREE.InstancedMesh(pylonGeometry, this.reactorMaterial, count);
    const dummy = new THREE.Object3D();
    for (let index = 0; index < count; index++) {
      const side = index % 2 ? -1 : 1;
      dummy.position.set(side * 9.5, 1.5, 8 - index * (length / count));
      dummy.scale.set(1, 1 + (index % 3) * 0.15, 1);
      dummy.updateMatrix();
      pylons.setMatrixAt(index, dummy.matrix);
    }
    pylons.instanceMatrix.needsUpdate = true;
    group.add(pylons);
  }

  buildCollapse(group, course, theme) {
    this.beaconMaterial = new THREE.MeshStandardMaterial({
      color: theme.secondary,
      emissive: theme.accent,
      emissiveIntensity: 1.4,
      roughness: 0.25
    });
    const debrisMaterial = new THREE.MeshStandardMaterial({
      color: 0x684047,
      roughness: 0.7,
      metalness: 0.08
    });
    const count = course.quality === 'low' ? 8 : 18;
    const debris = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2.2, 0.45, 1.2),
      debrisMaterial,
      count
    );
    const dummy = new THREE.Object3D();
    const span = Math.abs(course.spec.finishZ) + 20;

    for (let index = 0; index < count; index++) {
      const side = index % 2 ? -1 : 1;
      dummy.position.set(
        side * (11 + (index % 3) * 3.5),
        -1 + (index % 4),
        8 - ((index * 13) % span)
      );
      dummy.rotation.set((index % 3) * 0.18, index * 0.37, (index % 5) * 0.1);
      dummy.scale.set(0.8 + (index % 3) * 0.25, 1, 0.8 + (index % 2) * 0.35);
      dummy.updateMatrix();
      debris.setMatrixAt(index, dummy.matrix);
    }
    debris.instanceMatrix.needsUpdate = true;
    group.add(debris);

    for (const x of [-7.2, 7.2]) {
      for (const z of [4, course.spec.finishZ * 0.45, course.spec.finishZ * 0.8]) {
        const beacon = new THREE.Mesh(
          new THREE.SphereGeometry(0.3, 10, 8),
          this.beaconMaterial
        );
        beacon.position.set(x, 2.2, z);
        group.add(beacon);
      }
    }
  }

  animateWorld(game, dt, now) {
    if (this.rain && dt > 0) {
      const positions = this.rain.positions;
      for (let index = 0; index < this.rain.count; index++) {
        const offset = index * 3;
        positions[offset] += dt * 5.2;
        positions[offset + 1] -= dt * 19;
        if (positions[offset + 1] < -6) {
          positions[offset + 1] = 20 + (index % 7);
          positions[offset] = -22 + ((index * 37) % 440) / 10;
        }
      }
      this.rain.points.geometry.attributes.position.needsUpdate = true;
    }

    if (this.reactorMaterial) {
      this.reactorMaterial.emissiveIntensity = 0.95 + Math.sin(now * 0.004) * 0.28;
    }

    if (this.beaconMaterial) {
      const boost = this.finalSurge ? 1.1 : 0;
      this.beaconMaterial.emissiveIntensity = 1.2 + boost + (Math.sin(now * 0.009) + 1) * 0.65;
    }

    const visuals = game.coopControl?.signatureVisuals;
    const core = game.coopControl?.signatureState?.core;
    if (visuals?.socket && core && !core.insertedInto) {
      const position = game.coopControl.localCorePosition?.();
      const socket = game.coopControl.signature?.core?.socket;
      const distance =
        position && socket
          ? Math.hypot(position.x - socket.x, position.y - socket.y, position.z - socket.z)
          : Infinity;
      const proximity = Math.max(0, 1 - distance / 7);
      const pulse = 0.5 + Math.sin(now * 0.012) * 0.5;
      visuals.socket.scale.setScalar(1 + proximity * (0.08 + pulse * 0.05));
      setEmissive(visuals.socket, 0.8 + proximity * (1.2 + pulse));
    }
  }

  updateCore(game, now) {
    const core = game.coopControl?.signatureState?.core;
    const visuals = game.coopControl?.signatureVisuals;
    if (!core || !visuals?.core) {
      this.lastCore = null;
      this.lastThrow = null;
      return;
    }

    const speed = velocityLength(core.velocity);
    if (!core.carrier && !core.insertedInto && speed > 1.2 && now - this.lastTrailAt > 55) {
      game.effects?.trail?.(visuals.core.position, this.theme?.accent ?? 0xffd94b);
      this.lastTrailAt = now;
    }

    if (this.lastCore) {
      const wasCarrier = this.lastCore.carrier;
      const isCarrier = core.carrier;

      if (wasCarrier && !isCarrier && !core.insertedInto && speed > 1.2) {
        this.lastThrow = { carrier: wasCarrier, until: now + 3500 };
        this.coreThrow(game, visuals.core.position);
      }

      if (!wasCarrier && isCarrier) {
        const handoff = this.lastThrow && this.lastThrow.carrier !== isCarrier && now <= this.lastThrow.until;
        if (handoff) this.coreHandoff(game, visuals.core.position);
        else this.corePickup(game, visuals.core.position);
        this.lastThrow = null;
      }

      if (!this.lastCore.insertedInto && core.insertedInto) {
        this.coreInserted(game);
        this.lastThrow = null;
      }
    }

    this.lastCore = {
      carrier: core.carrier || null,
      insertedInto: core.insertedInto || null
    };
  }

  corePickup(game, position) {
    game.effects?.burst?.(position, this.theme?.accent ?? 0xffd94b, 8, 0.65);
    game.audio?.playTone?.({
      freq: [440, 720],
      type: 'triangle',
      duration: 0.18,
      volume: 0.11,
      position
    });
  }

  coreThrow(game, position) {
    game.cameraController?.addShake?.(0.16);
    game.audio?.playNoise?.({
      duration: 0.28,
      filter: 'bandpass',
      freq: 1800,
      sweepTo: 460,
      q: 1.3,
      volume: 0.1,
      position
    });
  }

  coreHandoff(game, position) {
    game.effects?.burst?.(position, this.theme?.accent ?? 0xffd94b, 18, 1);
    game.postFX?.pulse?.(0.55);
    game.ui?.toast?.('✦ ОТЛИЧНАЯ ПЕРЕДАЧА', 'info', 1800);
    game.audio?.playTone?.({
      freq: [620, 930],
      type: 'sine',
      duration: 0.28,
      volume: 0.16,
      position
    });
  }

  coreInserted(game) {
    const socket = game.coopControl?.signature?.core?.socket;
    const position = vectorFrom(socket);
    game.effects?.burst?.(position, this.theme?.accent ?? 0x4dffcf, 28, 1.45);
    game.effects?.burst?.(position, this.theme?.secondary ?? 0x45bfff, 18, 1.05);
    game.postFX?.pulse?.(0.95);
    game.cameraController?.addShake?.(0.52);
    game.ui?.toast?.('✦ ЯДРО УСТАНОВЛЕНО · СЕТЬ ЗАПИТАНА', 'info', 2600);
    game.audio?.playTone?.({
      freq: [220, 440, 880],
      type: 'triangle',
      duration: 0.58,
      volume: 0.2,
      position
    });
    if (this.reactorMaterial) this.reactorMaterial.emissiveIntensity = 2.8;
  }

  updateSignal(game) {
    const signal = game.coopControl?.signatureState?.signal;
    const visuals = game.coopControl?.signatureVisuals;
    if (!signal || !visuals?.guide) {
      this.lastSignal = null;
      return;
    }

    if (this.lastSignal) {
      if (signal.progress > this.lastSignal.progress) {
        const index = Math.max(0, signal.progress - 1);
        const button = visuals.buttons?.[index];
        const position =
          button?.getWorldPosition?.(new THREE.Vector3()) || visuals.operator.position;
        game.effects?.burst?.(position, this.theme?.accent ?? 0x4dffcf, 8, 0.55);
        game.audio?.playTone?.({
          freq: 560 + signal.progress * 95,
          type: 'sine',
          duration: 0.12,
          volume: 0.1,
          position
        });
      } else if (
        signal.progress === 0 &&
        this.lastSignal.progress > 0 &&
        !signal.solved &&
        !this.lastSignal.solved
      ) {
        game.postFX?.pulse?.(0.18);
        game.audio?.playTone?.({
          freq: [260, 150],
          type: 'square',
          duration: 0.16,
          volume: 0.09
        });
      }

      if (signal.solved && !this.lastSignal.solved) {
        const guide = visuals.guide.getWorldPosition(new THREE.Vector3());
        const operator = visuals.operator.getWorldPosition(new THREE.Vector3());
        game.effects?.burst?.(guide, this.theme?.accent ?? 0x4dffcf, 16, 0.9);
        game.effects?.burst?.(operator, this.theme?.secondary ?? 0x45bfff, 16, 0.9);
        game.postFX?.pulse?.(0.72);
        game.cameraController?.addShake?.(0.24);
        game.ui?.toast?.('✦ СИГНАЛ СИНХРОНИЗИРОВАН', 'info', 2300);
        game.audio?.playTone?.({
          freq: [520, 780, 1040],
          type: 'triangle',
          duration: 0.45,
          volume: 0.16
        });
      }
    }

    this.lastSignal = {
      progress: signal.progress || 0,
      solved: Boolean(signal.solved)
    };
  }

  updateFinale(game) {
    if (this.finalSurge || this.theme?.id !== 'collapse' || !game.running || !game.player) return;
    const progress = game.course?.progress?.(game.player.position, game.player.checkpoint) || 0;
    if (progress < 0.72) return;

    this.finalSurge = true;
    game.postFX?.pulse?.(0.65);
    game.cameraController?.addShake?.(0.2);
    game.ui?.toast?.('ФИНАЛ · ДЕРЖИТЕСЬ ВМЕСТЕ', 'info', 2600);
    game.audio?.playTone?.({
      freq: [110, 165, 220],
      type: 'sawtooth',
      duration: 0.6,
      volume: 0.12
    });
  }

  ensureBanner() {
    if (this.banner || !globalThis.document) return this.banner;
    const root = document.createElement('div');
    root.id = 'campaignChapterBanner';
    root.className = 'glass hidden';
    root.style.cssText =
      'position:fixed;top:max(92px,env(safe-area-inset-top));left:50%;transform:translate(-50%,-8px);z-index:24;pointer-events:none;min-width:min(82vw,360px);padding:10px 16px;text-align:center;opacity:0;transition:opacity .32s ease,transform .32s ease';
    const world = document.createElement('small');
    world.style.cssText = 'display:block;letter-spacing:.16em;font-weight:800;opacity:.75';
    const title = document.createElement('strong');
    title.style.cssText = 'display:block;margin-top:3px;font-size:clamp(16px,4vw,22px)';
    const subtitle = document.createElement('span');
    subtitle.style.cssText = 'display:block;margin-top:2px;font-size:12px;opacity:.8';
    root.append(world, title, subtitle);
    document.body.append(root);
    this.banner = { root, world, title, subtitle };
    return this.banner;
  }

  showChapterBanner(spec, theme) {
    const banner = this.ensureBanner();
    if (!banner) return;
    const chapter = campaignChapterNumber(spec.chapterId);
    banner.world.textContent = `МИР · ${theme.world}`;
    banner.title.textContent = `ГЛАВА ${chapter} · ${spec.title}`;
    banner.subtitle.textContent = spec.subtitle || '';
    banner.root.classList.remove('hidden');
    requestAnimationFrame(() => {
      banner.root.style.opacity = '1';
      banner.root.style.transform = 'translate(-50%,0)';
    });
    this.bannerTimer = setTimeout(() => {
      banner.root.style.opacity = '0';
      banner.root.style.transform = 'translate(-50%,-8px)';
      setTimeout(() => banner.root.classList.add('hidden'), 340);
    }, 3000);
  }
}

export function installCampaignPresentation(options = {}) {
  if (globalThis.__WOBBLE_CAMPAIGN_PRESENTATION__) {
    return globalThis.__WOBBLE_CAMPAIGN_PRESENTATION__;
  }
  const presentation = new CampaignPresentation(options);
  globalThis.__WOBBLE_CAMPAIGN_PRESENTATION__ = presentation;
  presentation.start();
  return presentation;
}
