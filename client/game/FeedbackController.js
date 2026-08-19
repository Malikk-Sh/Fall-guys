import { PLAYER_OBSTACLE_RADIUS } from './PlayerDimensions.js';

const FLOW_COOLDOWN_MS = 650;
const PLACE_COOLDOWN_MS = 420;
const NEAR_MISS_COOLDOWN_MS = 900;
const NEAR_MISS_SCAN_MS = 70;
const NEAR_MISS_MARGIN = 0.48;
const NEAR_MISS_MAX_DWELL_MS = 720;

const FLOW_IMPULSES = Object.freeze({
  'dive-roll': { pitch: 0.012, fov: 0.8, shake: 0.035, duration: 0.12 },
  'roll-jump': { pitch: -0.018, fov: 1.2, shake: 0.025, duration: 0.15 },
  'fast-landing': { pitch: 0.01, fov: -0.45, shake: 0.02, duration: 0.1 }
});

export function flowSignal(previous, current) {
  if (!previous || !current) return null;

  if (previous.diving && !current.diving && current.rolling) {
    return { id: 'dive-roll', label: 'ЧИСТО', tone: 'cyan', strength: 0.45 };
  }

  if (previous.rolling && !current.rolling && !current.grounded && current.vertical > 1.5) {
    return { id: 'roll-jump', label: 'ПОТОК ×2', tone: 'yellow', strength: 0.62 };
  }

  if (
    previous.landingRetention <= 0 &&
    current.landingRetention > 0 &&
    !current.rolling &&
    current.grounded
  ) {
    return { id: 'fast-landing', label: 'МЯГКО', tone: 'mint', strength: 0.34 };
  }

  return null;
}

export function placeDirection(previous, current) {
  if (!Number.isInteger(previous) || !Number.isInteger(current) || previous <= 0 || current <= 0) return null;
  if (current < previous) return 'up';
  if (current > previous) return 'down';
  return null;
}

// Дистанция до уже существующего collision envelope движущегося препятствия.
// `inside` отделён от внешнего halo намеренно: решение о попадании принадлежит Course.interact(),
// а presentation нужен этот флаг только для того, чтобы никогда не наградить фактический контакт.
export function nearMissSample(obstacle, position, radius = PLAYER_OBSTACLE_RADIUS) {
  if (!obstacle || !position || !Number.isFinite(radius) || radius < 0) return null;

  if (obstacle.type === 'spinner') {
    const center = obstacle.center;
    if (!center || Math.abs(position.y - center.y) >= 1.18) return null;
    const dx = position.x - center.x;
    const dz = position.z - center.z;
    const angle = Number(obstacle.angle) || 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const along = dx * cos - dz * sin;
    const cross = dx * sin + dz * cos;
    const key = obstacle.mesh?.uuid || null;
    const side = Math.sign(cross) || Math.sign(along) || 1;
    const outsideAlong = Math.max(0, Math.abs(along) - (obstacle.length / 2 + radius));
    const outsideCross = Math.max(0, Math.abs(cross) - (obstacle.width / 2 + radius));
    if (outsideAlong === 0 && outsideCross === 0) return { key, gap: 0, side, inside: true };
    const gap = Math.hypot(outsideAlong, outsideCross);
    if (gap > NEAR_MISS_MARGIN) return null;
    return { key, gap, side, inside: false };
  }

  if (obstacle.type === 'puncher') {
    const mesh = obstacle.mesh;
    if (!mesh?.position || Math.abs(position.y - mesh.position.y) >= 1.62) return null;
    const dx = position.x - mesh.position.x;
    const dz = position.z - mesh.position.z;
    const key = mesh.uuid || null;
    const side = Math.sign(dx) || 1;
    const outsideX = Math.max(0, Math.abs(dx) - (obstacle.w / 2 + radius));
    const outsideZ = Math.max(0, Math.abs(dz) - (obstacle.d / 2 + radius));
    if (outsideX === 0 && outsideZ === 0) return { key, gap: 0, side, inside: true };
    const gap = Math.hypot(outsideX, outsideZ);
    if (gap > NEAR_MISS_MARGIN) return null;
    return { key, gap, side, inside: false };
  }

  return null;
}

function playerPresentationState(player) {
  return {
    diving: player.diveTimer > 0,
    rolling: player.rollTimer > 0,
    landingRetention: player.landingRetention || 0,
    grounded: Boolean(player.grounded),
    vertical: Number(player.velocity?.y) || 0,
    knockedDown: player.knockdownTimer > 0,
    immunity: player.knockdownImmunityTimer > 0,
    respawns: Number(player.respawns) || 0,
    checkpoint: Number(player.checkpoint) || 0,
    finished: Boolean(player.finished)
  };
}

function parsePlace(root) {
  const value = Number.parseInt(root?.getElementById?.('place')?.textContent || '', 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

const STYLE = `
.game-feel-feedback {
  position: fixed;
  z-index: 1450;
  left: 50%;
  bottom: max(calc(118px + env(safe-area-inset-bottom)), 20vh);
  transform: translateX(-50%);
  display: grid;
  justify-items: center;
  gap: 5px;
  pointer-events: none;
}
.game-feel-chip {
  min-width: 92px;
  padding: 7px 13px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 999px;
  color: #fff;
  background: rgba(31, 18, 76, 0.78);
  box-shadow: 0 8px 24px rgba(24, 15, 65, 0.24);
  font-size: clamp(10px, 1.45vw, 14px);
  font-weight: 950;
  line-height: 1;
  letter-spacing: 0.08em;
  text-align: center;
  text-shadow: 0 1px 8px rgba(8, 5, 35, 0.45);
  backdrop-filter: blur(8px);
  animation: game-feel-chip 720ms cubic-bezier(0.16, 0.9, 0.28, 1) both;
}
.game-feel-chip[data-tone='cyan'] { box-shadow: 0 8px 28px rgba(76, 224, 223, 0.28); }
.game-feel-chip[data-tone='yellow'] { box-shadow: 0 8px 28px rgba(255, 221, 76, 0.28); }
.game-feel-chip[data-tone='mint'] { box-shadow: 0 8px 28px rgba(110, 255, 199, 0.24); }
.game-feel-chip[data-tone='pink'] { box-shadow: 0 8px 28px rgba(255, 102, 184, 0.3); }
.game-feel-impact {
  position: fixed;
  z-index: 1420;
  inset: 50% auto auto 50%;
  width: 78px;
  height: 78px;
  margin: -39px 0 0 -39px;
  border: 5px solid rgba(255, 235, 118, 0.88);
  border-radius: 50%;
  opacity: 0;
  pointer-events: none;
}
.game-feel-impact.active {
  animation: game-feel-impact 360ms cubic-bezier(0.12, 0.75, 0.24, 1) both;
}
.game-feel-respawn {
  position: fixed;
  z-index: 1410;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  background: radial-gradient(circle at center, transparent 0 8%, rgba(68, 231, 255, 0.2) 34%, transparent 68%);
}
.game-feel-respawn.active {
  animation: game-feel-respawn 420ms ease-out both;
}
#placeBox.place-gain strong,
#placeBox.place-loss strong {
  display: inline-block;
}
#placeBox.place-gain strong { animation: game-feel-place-up 320ms cubic-bezier(0.18, 0.9, 0.3, 1.18); }
#placeBox.place-loss strong { animation: game-feel-place-down 260ms ease-out; }
@keyframes game-feel-chip {
  0% { opacity: 0; transform: translateY(8px) scale(0.9); }
  24% { opacity: 1; transform: translateY(-2px) scale(1.05); }
  68% { opacity: 1; transform: none; }
  100% { opacity: 0; transform: translateY(-5px); }
}
@keyframes game-feel-impact {
  0% { opacity: 0.95; transform: scale(0.32); }
  100% { opacity: 0; transform: scale(2.6); }
}
@keyframes game-feel-respawn {
  0% { opacity: 0; transform: scale(0.82); }
  28% { opacity: 1; }
  100% { opacity: 0; transform: scale(1.12); }
}
@keyframes game-feel-place-up {
  0% { transform: translateY(0) scale(1); }
  42% { transform: translateY(-4px) scale(1.18); }
  100% { transform: none; }
}
@keyframes game-feel-place-down {
  0% { transform: translateY(0); }
  45% { transform: translateY(3px); }
  100% { transform: none; }
}
body.reduced-motion .game-feel-chip,
body.reduced-motion .game-feel-impact.active,
body.reduced-motion .game-feel-respawn.active,
body.reduced-motion #placeBox.place-gain strong,
body.reduced-motion #placeBox.place-loss strong {
  animation-duration: 80ms !important;
  transform: none !important;
}
@media (max-height: 420px) {
  .game-feel-feedback {
    bottom: max(calc(88px + env(safe-area-inset-bottom)), 18vh);
  }
  .game-feel-chip {
    padding: 6px 10px;
    font-size: 10px;
  }
}
`;

export class FeedbackController {
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
    this.player = null;
    this.previous = null;
    this.lastFlowAt = -Infinity;
    this.lastPlaceAt = -Infinity;
    this.lastNearMissAt = -Infinity;
    this.nextNearMissScanAt = 0;
    this.nearMissCandidates = new Map();
    this.lastPlace = null;
    this.lastMode = null;
  }

  init() {
    if (this.active || !this.root?.body) return this;
    this.active = true;
    this.installMarkup();
    this.schedule();
    return this;
  }

  destroy() {
    this.active = false;
    if (this.frame) this.window?.cancelAnimationFrame?.(this.frame);
    this.frame = 0;
    this.resetTracking();
  }

  installMarkup() {
    if (!this.root.getElementById('gameFeelStyle')) {
      const style = this.root.createElement('style');
      style.id = 'gameFeelStyle';
      style.textContent = STYLE;
      this.root.head?.append(style);
    }
    if (!this.root.getElementById('gameFeelFeedback')) {
      const layer = this.root.createElement('div');
      layer.id = 'gameFeelFeedback';
      layer.className = 'game-feel-feedback';
      layer.setAttribute('aria-live', 'polite');
      layer.setAttribute('aria-atomic', 'true');
      this.root.body.append(layer);
    }
    if (!this.root.getElementById('gameFeelImpact')) {
      const impact = this.root.createElement('div');
      impact.id = 'gameFeelImpact';
      impact.className = 'game-feel-impact';
      impact.setAttribute('aria-hidden', 'true');
      this.root.body.append(impact);
    }
    if (!this.root.getElementById('gameFeelRespawn')) {
      const respawn = this.root.createElement('div');
      respawn.id = 'gameFeelRespawn';
      respawn.className = 'game-feel-respawn';
      respawn.setAttribute('aria-hidden', 'true');
      this.root.body.append(respawn);
    }
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
    const player = game?.player;
    const activeGameplay = Boolean(game?.running && player && game.mode !== 'preview');
    if (!activeGameplay) {
      this.resetTracking();
      return;
    }

    if (this.player !== player) {
      this.resetTracking();
      this.player = player;
      this.previous = playerPresentationState(player);
      this.lastPlace = parsePlace(this.root);
      this.lastMode = game.mode;
      player.character?.setImmunityGlow?.(this.previous.immunity);
      return;
    }

    const current = playerPresentationState(player);
    player.character?.setImmunityGlow?.(current.immunity);
    if (!this.previous.knockedDown && current.knockedDown) this.presentKnockdown(game);
    if (current.respawns > this.previous.respawns) this.presentRespawn(game);
    if (current.checkpoint > this.previous.checkpoint) this.presentCheckpoint(game, current.checkpoint);
    if (!this.previous.finished && current.finished) this.presentFinish(game);

    const flow = flowSignal(this.previous, current);
    if (flow && now - this.lastFlowAt >= FLOW_COOLDOWN_MS) {
      this.lastFlowAt = now;
      this.presentFlow(game, flow);
    }

    if (!current.knockedDown && !player.downed) this.trackNearMiss(game, now);
    else this.nearMissCandidates.clear();

    if (this.lastMode !== game.mode) {
      this.lastMode = game.mode;
      this.lastPlace = parsePlace(this.root);
    }
    if (game.mode === 'multi' && !game.spectating) this.trackPlace(now);
    else this.lastPlace = null;

    this.previous = current;
  }

  resetTracking() {
    this.player?.character?.setImmunityGlow?.(false);
    this.player = null;
    this.previous = null;
    this.lastPlace = null;
    this.lastMode = null;
    this.nextNearMissScanAt = 0;
    this.nearMissCandidates.clear();
  }

  presentFlow(game, flow) {
    this.showChip(flow.label, flow.tone);
    game.settings?.vibrate?.(flow.strength * 0.45);
    const impulse = FLOW_IMPULSES[flow.id];
    if (impulse) game.cameraController?.addImpulse?.(impulse);
  }

  presentKnockdown(game) {
    const player = game.player;
    const reduced = Boolean(game.settings?.reducedMotion);
    game.effects?.burst?.(player.position, 0xffdd76, reduced ? 5 : 12, reduced ? 0.42 : 0.78);
    game.cameraController?.addImpulse?.({ pitch: 0.035, fov: -1.1, shake: 0.34, duration: 0.16 });
    game.settings?.vibrate?.(0.7);
    this.restartAnimation(this.root.getElementById('gameFeelImpact'), 'active');
  }

  presentRespawn(game) {
    const player = game.player;
    const reduced = Boolean(game.settings?.reducedMotion);
    game.effects?.burst?.(player.position, 0x54e0ff, reduced ? 6 : 16, reduced ? 0.45 : 0.7);
    game.cameraController?.addImpulse?.({ pitch: -0.012, fov: 1.1, duration: 0.18 });
    this.restartAnimation(this.root.getElementById('gameFeelRespawn'), 'active');
  }

  presentCheckpoint(game, checkpoint) {
    this.showChip(`ЧЕКПОИНТ ${checkpoint}`, 'mint');
    game.cameraController?.addImpulse?.({ pitch: -0.012, fov: 0.75, duration: 0.14 });
  }

  presentFinish(game) {
    this.showChip('ФИНИШ!', 'yellow');
    game.cameraController?.addImpulse?.({ pitch: -0.02, fov: 1.7, duration: 0.22 });
  }

  trackNearMiss(game, now) {
    if (now < this.nextNearMissScanAt) return;
    this.nextNearMissScanAt = now + NEAR_MISS_SCAN_MS;
    const player = game.player;
    const obstacles = game.course?.obstacles;
    if (!Array.isArray(obstacles)) return;

    for (const obstacle of obstacles) {
      const sample = nearMissSample(obstacle, player.position);
      const key = sample?.key || obstacle.mesh?.uuid;
      if (!key) continue;
      const candidate = this.nearMissCandidates.get(key);
      if (sample?.inside) {
        this.nearMissCandidates.delete(key);
        continue;
      }
      if (sample) {
        if (candidate) {
          candidate.gap = Math.min(candidate.gap, sample.gap);
          candidate.side = sample.side;
          candidate.exitedAt = 0;
        } else {
          this.nearMissCandidates.set(key, {
            enteredAt: now,
            exitedAt: 0,
            hits: Number(player.hits) || 0,
            gap: sample.gap,
            side: sample.side
          });
        }
        continue;
      }
      if (!candidate) continue;
      if (!candidate.exitedAt) {
        candidate.exitedAt = now;
        continue;
      }
      if (now - candidate.exitedAt < NEAR_MISS_SCAN_MS) continue;

      this.nearMissCandidates.delete(key);
      const dwell = candidate.exitedAt - candidate.enteredAt;
      const cleanPass = dwell >= NEAR_MISS_SCAN_MS && dwell <= NEAR_MISS_MAX_DWELL_MS;
      const noHit = (Number(player.hits) || 0) === candidate.hits;
      if (cleanPass && noHit && now - this.lastNearMissAt >= NEAR_MISS_COOLDOWN_MS) {
        this.lastNearMissAt = now;
        this.presentNearMiss(game, candidate);
      }
    }
  }

  presentNearMiss(game, candidate) {
    this.showChip('НА ГРАНИ', 'pink');
    game.settings?.vibrate?.(0.16);
    game.cameraController?.addImpulse?.({
      yaw: candidate.side * 0.018,
      fov: 0.65,
      shake: 0.02,
      duration: 0.12
    });
  }

  trackPlace(now) {
    const current = parsePlace(this.root);
    if (!current) return;
    if (!this.lastPlace) {
      this.lastPlace = current;
      return;
    }
    const direction = placeDirection(this.lastPlace, current);
    this.lastPlace = current;
    if (!direction || now - this.lastPlaceAt < PLACE_COOLDOWN_MS) return;
    this.lastPlaceAt = now;

    const box = this.root.getElementById('placeBox');
    if (!box) return;
    const className = direction === 'up' ? 'place-gain' : 'place-loss';
    box.classList.remove('place-gain', 'place-loss');
    void box.offsetWidth;
    box.classList.add(className);
    const clear = this.window?.setTimeout || globalThis.setTimeout;
    clear?.(() => box.classList.remove(className), 360);
  }

  showChip(label, tone = 'cyan') {
    const layer = this.root.getElementById('gameFeelFeedback');
    if (!layer) return;
    const chip = this.root.createElement('div');
    chip.className = 'game-feel-chip';
    chip.dataset.tone = tone;
    chip.textContent = label;
    layer.replaceChildren(chip);
    const remove = this.window?.setTimeout || globalThis.setTimeout;
    remove?.(() => {
      if (chip.isConnected) chip.remove();
    }, 760);
  }

  restartAnimation(node, className) {
    if (!node) return;
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
    const clear = this.window?.setTimeout || globalThis.setTimeout;
    clear?.(() => node.classList.remove(className), 460);
  }
}

export function installFeedbackController(options = {}) {
  const controller = new FeedbackController(options);
  controller.init();
  return controller;
}
