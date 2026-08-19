import * as THREE from 'three';

const PING_PRESENTATION = Object.freeze({
  here: { label: 'СЮДА', glyph: '⌖', color: 0x54e0ff, anchor: 'ground', ring: true, beam: true },
  wait: { label: 'ЖДИ', glyph: 'Ⅱ', color: 0xffdd76, anchor: 'actor', ring: false, beam: false },
  go: { label: 'ИДИ', glyph: '➤', color: 0x54e0ff, anchor: 'actor', ring: true, beam: false },
  help: {
    label: 'ПОМОГИ',
    glyph: '!',
    color: 0xff5f91,
    anchor: 'actor',
    ring: true,
    beam: true,
    urgent: true
  },
  ready: { label: 'ГОТОВ', glyph: '✓', color: 0x6effc7, anchor: 'actor', ring: true, beam: false },
  thanks: { label: 'СПАСИБО', glyph: '♥', color: 0xff91c8, anchor: 'actor', ring: false, beam: false }
});

export function pingPresentation(command) {
  return PING_PRESENTATION[command] || null;
}

export function pingIdentity(matchId, ping, now = -Infinity) {
  if (!matchId || !ping?.id || !pingPresentation(ping.command)) return null;
  if (!Number.isFinite(ping.until) || ping.until <= now) return null;
  return `${matchId}:${ping.id}:${ping.command}:${ping.until}`;
}

export function partnerPingCommand(selfId, ping, now = -Infinity) {
  if (!selfId || !ping?.id || ping.id === selfId || !pingPresentation(ping.command)) return null;
  if (!Number.isFinite(ping.until) || ping.until <= now) return null;
  return ping.command;
}

function markerCanvas(root) {
  const canvas = root.createElement('canvas');
  canvas.width = 384;
  canvas.height = 128;
  return canvas;
}

export class CoopPingPresentation {
  constructor({
    windowRef = globalThis,
    root = globalThis.document,
    getGame = () => globalThis.__WOBBLE_GAME__
  } = {}) {
    this.window = windowRef;
    this.root = root;
    this.getGame = getGame;
    this.frame = 0;
    this.active = false;
    this.scene = null;
    this.group = null;
    this.ring = null;
    this.beam = null;
    this.sprite = null;
    this.spriteCanvas = null;
    this.spriteTexture = null;
    this.identity = null;
    this.matchId = null;
    this.anchor = new THREE.Vector3();
    this.hasSnapshotAnchor = false;
  }

  init() {
    if (this.active) return this;
    this.active = true;
    this.schedule();
    return this;
  }

  destroy() {
    this.active = false;
    if (this.frame) this.window?.cancelAnimationFrame?.(this.frame);
    this.frame = 0;
    this.hide();
    this.disposeMarker();
  }

  schedule() {
    if (!this.active || this.frame) return;
    this.frame = this.window?.requestAnimationFrame?.(time => {
      this.frame = 0;
      this.tick(Number(time) || 0);
      this.schedule();
    });
  }

  tick(now) {
    const game = this.getGame?.();
    const currentMatchId = game?.net?.matchId || null;
    this.handleMatchChange(game, currentMatchId);

    if (!game?.running || game.mode !== 'coop' || !game.scene || !currentMatchId) {
      this.hide();
      return;
    }

    const ping = game.coopControl?.ping;
    const config = pingPresentation(ping?.command);
    const identity = pingIdentity(currentMatchId, ping, now);
    if (!config || !identity) {
      this.hide();
      return;
    }

    const actor = ping.id === game.net?.id ? game.player : game.remotes?.get?.(ping.id);
    if (!actor?.visualPosition) {
      this.hide();
      return;
    }

    this.ensureMarker(game.scene);
    if (identity !== this.identity) {
      this.beginPing(identity, config, actor.visualPosition);
      if (config.urgent && ping.id !== game.net?.id) game.settings?.vibrate?.(0.18);
    }
    this.updatePartnerPriority(game, ping, now);
    this.updateMarker(config, actor.visualPosition, ping.until, now, Boolean(game.settings?.reducedMotion));
  }

  handleMatchChange(game, currentMatchId) {
    if (this.matchId === currentMatchId) return;
    if (this.matchId && game?.coopControl?.ping) {
      game.coopControl.ping = null;
      game.ui?.updateCoopPing?.(null);
    }
    this.matchId = currentMatchId;
    this.identity = null;
    this.hasSnapshotAnchor = false;
    this.hide();
  }

  ensureMarker(scene) {
    if (this.group && this.scene === scene) return;
    this.disposeMarker();
    this.scene = scene;

    const group = new THREE.Group();
    group.name = 'coop-ping-presentation';
    group.visible = false;

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.82, 32), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    group.add(ring);

    const beamMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.34,
      depthWrite: false
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.11, 3.2, 8), beamMaterial);
    beam.position.y = 1.62;
    group.add(beam);

    const canvas = markerCanvas(this.root);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: true })
    );
    sprite.position.y = 2.55;
    sprite.scale.set(3.1, 1.04, 1);
    group.add(sprite);

    scene.add(group);
    this.group = group;
    this.ring = ring;
    this.beam = beam;
    this.sprite = sprite;
    this.spriteCanvas = canvas;
    this.spriteTexture = texture;
  }

  beginPing(identity, config, actorPosition) {
    this.identity = identity;
    this.hasSnapshotAnchor = false;
    if (config.anchor === 'ground') {
      this.anchor.copy(actorPosition);
      this.hasSnapshotAnchor = true;
    }
    this.drawLabel(config);
  }

  drawLabel(config) {
    const context = this.spriteCanvas?.getContext?.('2d');
    if (!context) return;
    context.clearRect(0, 0, this.spriteCanvas.width, this.spriteCanvas.height);
    context.fillStyle = 'rgba(31, 18, 76, 0.84)';
    context.fillRect(12, 14, 360, 100);
    context.font = '900 52px Trebuchet MS, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#ffffff';
    context.fillText(`${config.glyph}  ${config.label}`, 192, 64, 330);
    this.spriteTexture.needsUpdate = true;
  }

  updateMarker(config, actorPosition, until, now, reducedMotion) {
    const position = this.hasSnapshotAnchor ? this.anchor : actorPosition;
    const groundOffset = config.anchor === 'ground' ? 0.05 : 0.3;
    this.group.position.set(position.x, position.y - groundOffset, position.z);
    this.group.visible = true;

    this.ring.visible = Boolean(config.ring);
    this.beam.visible = Boolean(config.beam);
    this.ring.material.color.setHex(config.color);
    this.beam.material.color.setHex(config.color);
    this.sprite.material.color.setHex(config.color);

    const life = Math.max(0, Math.min(1, (until - now) / 1800));
    const pulseAmount = config.urgent ? 0.18 : 0.09;
    const pulse = reducedMotion ? 1 : 1 + Math.sin(now * (config.urgent ? 0.018 : 0.011)) * pulseAmount;
    this.ring.scale.setScalar(pulse);
    this.ring.material.opacity = (config.urgent ? 0.9 : 0.72) * Math.min(1, life * 3);
    this.beam.material.opacity = (config.urgent ? 0.48 : 0.3) * Math.min(1, life * 3);
    this.sprite.material.opacity = Math.min(1, life * 4);
    const bob = reducedMotion ? 0 : Math.sin(now * 0.008) * 0.08;
    this.sprite.position.y = config.anchor === 'ground' ? 2.55 : 2.35 + bob;
  }

  updatePartnerPriority(game, ping, now) {
    const hud = this.root?.getElementById?.('partnerHud');
    if (!hud) return;
    const command = partnerPingCommand(game.net?.id, ping, now) || '';
    if (hud.dataset.pingCommand !== command) hud.dataset.pingCommand = command;
    hud.setAttribute('aria-label', command === 'help' ? 'Напарнику нужна помощь' : 'Напарник');
  }

  hide() {
    if (this.group) this.group.visible = false;
    const hud = this.root?.getElementById?.('partnerHud');
    if (hud) {
      if (hud.dataset.pingCommand) hud.dataset.pingCommand = '';
      hud.setAttribute('aria-label', 'Напарник');
    }
    this.identity = null;
    this.hasSnapshotAnchor = false;
  }

  disposeMarker() {
    if (!this.group) return;
    this.scene?.remove?.(this.group);
    this.ring?.geometry?.dispose?.();
    this.ring?.material?.dispose?.();
    this.beam?.geometry?.dispose?.();
    this.beam?.material?.dispose?.();
    this.sprite?.material?.dispose?.();
    this.spriteTexture?.dispose?.();
    this.group = null;
    this.ring = null;
    this.beam = null;
    this.sprite = null;
    this.spriteCanvas = null;
    this.spriteTexture = null;
    this.scene = null;
  }
}

export function installCoopPingPresentation(options = {}) {
  const presentation = new CoopPingPresentation(options);
  presentation.init();
  return presentation;
}
