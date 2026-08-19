const GESTURE_DISTANCE = 6;
const GESTURE_DURATION_MS = 620;
const CORE_CATCH_SPEED = 1.6;

const MOMENT_PRESENTATION = Object.freeze({
  'revive-partner': { color: 0x6effc7, haptic: 0.34, fov: 0.8, pitch: -0.012 },
  'revived-self': { color: 0x54e0ff, haptic: 0.3, fov: 0.65, pitch: -0.01 },
  'core-catch': { color: 0xffdd76, haptic: 0.2, fov: 0.45, pitch: -0.008 },
  'core-insert': { color: 0x6effc7, haptic: 0.32, fov: 0.9, pitch: -0.014 },
  'signal-solved': { color: 0x54e0ff, haptic: 0.32, fov: 0.9, pitch: -0.014 }
});

function coreSpeed(core) {
  return Math.hypot(
    Number(core?.velocity?.x) || 0,
    Number(core?.velocity?.y) || 0,
    Number(core?.velocity?.z) || 0
  );
}

export function coopCelebrationState(game) {
  const core = game?.coopControl?.signatureState?.core;
  const signal = game?.coopControl?.signatureState?.signal;
  return {
    revives: Number(game?.coop?.revives) || 0,
    receivedRevives: Number(game?.coop?.receivedRevives) || 0,
    coreCarrier: core?.carrier || null,
    coreInserted: Boolean(core?.insertedInto),
    coreSpeed: coreSpeed(core),
    signalSolved: Boolean(signal?.solved)
  };
}

export function coopCelebrationMoments(previous, current) {
  if (!previous || !current) return [];
  const moments = [];

  if (current.revives > previous.revives) moments.push('revive-partner');
  if (current.receivedRevives > previous.receivedRevives) moments.push('revived-self');

  if (
    !previous.coreInserted &&
    !current.coreInserted &&
    !previous.coreCarrier &&
    current.coreCarrier &&
    previous.coreSpeed >= CORE_CATCH_SPEED
  ) {
    moments.push('core-catch');
  }
  if (!previous.coreInserted && current.coreInserted) moments.push('core-insert');
  if (!previous.signalSolved && current.signalSolved) moments.push('signal-solved');

  return moments;
}

export function gestureWeight(startedAt, now, duration = GESTURE_DURATION_MS) {
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(duration) ||
    duration <= 0
  )
    return 0;
  const progress = (now - startedAt) / duration;
  if (progress <= 0 || progress >= 1) return 0;
  return Math.sin(progress * Math.PI);
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function relativePartnerSide(actor, partnerPosition) {
  const position = actor?.visualPosition;
  const yaw = Number(actor?.character?.group?.rotation?.y) || 0;
  if (!position || !partnerPosition) return 1;
  const dx = partnerPosition.x - position.x;
  const dz = partnerPosition.z - position.z;
  const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  return right < 0 ? -1 : 1;
}

function relativeHeadYaw(actor, partnerPosition) {
  const position = actor?.visualPosition;
  const yaw = Number(actor?.character?.group?.rotation?.y) || 0;
  if (!position || !partnerPosition) return 0;
  const wanted = Math.atan2(-(partnerPosition.x - position.x), -(partnerPosition.z - position.z));
  let delta = ((wanted - yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return Math.max(-0.55, Math.min(0.55, delta));
}

function resetGesture(actor) {
  const character = actor?.character;
  if (!character) return;
  character.leftArm.rotation.z = 0;
  character.rightArm.rotation.z = 0;
  character.headAnchor.rotation.y = 0;
  character.faceAnchor.rotation.y = 0;
}

function applyGesture(actor, partnerPosition, weight) {
  const character = actor?.character;
  if (!character) return;

  // Используем каналы, которые базовая locomotion/emote-анимация не занимает: arm.rotation.z и
  // head/face rotation.y. Это настоящий overlay-layer — бег, прыжок и эмоция продолжают писать
  // свои x/visual-каналы, не получая forced state от celebration.
  const side = relativePartnerSide(actor, partnerPosition);
  const headYaw = relativeHeadYaw(actor, partnerPosition) * weight;
  character.headAnchor.rotation.y = headYaw;
  character.faceAnchor.rotation.y = headYaw * 0.72;
  character.leftArm.rotation.z = side < 0 ? 0.95 * weight : 0;
  character.rightArm.rotation.z = side > 0 ? -0.95 * weight : 0;
}

export class CoopCelebrationPresentation {
  constructor({ windowRef = globalThis, getGame = () => globalThis.__WOBBLE_GAME__ } = {}) {
    this.window = windowRef;
    this.getGame = getGame;
    this.frame = 0;
    this.active = false;
    this.matchId = null;
    this.previous = null;
    this.gesture = null;
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
    this.reset();
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
    const matchId = game?.net?.matchId || null;
    const activeCoop = Boolean(game?.running && game.mode === 'coop' && matchId && game.player);

    if (!activeCoop) {
      this.reset();
      this.matchId = matchId;
      return;
    }

    if (this.matchId !== matchId) {
      this.reset();
      this.matchId = matchId;
      this.previous = coopCelebrationState(game);
      return;
    }

    const current = coopCelebrationState(game);
    if (!this.previous) {
      this.previous = current;
      return;
    }

    for (const moment of coopCelebrationMoments(this.previous, current)) this.present(game, moment, now);
    this.previous = current;
    this.updateGesture(game, now);
  }

  present(game, moment, now) {
    const presentation = MOMENT_PRESENTATION[moment];
    if (!presentation) return;

    const partner = game.remotes?.values?.().next?.().value || null;
    const reduced = Boolean(game.settings?.reducedMotion);
    game.effects?.burst?.(game.player.position, presentation.color, reduced ? 5 : 9, reduced ? 0.38 : 0.62);
    if (partner?.position) {
      game.effects?.burst?.(partner.position, presentation.color, reduced ? 3 : 6, reduced ? 0.32 : 0.52);
    }
    game.settings?.vibrate?.(presentation.haptic);
    game.cameraController?.addImpulse?.({
      pitch: presentation.pitch,
      fov: presentation.fov,
      shake: 0.018,
      duration: 0.13
    });

    if (
      !reduced &&
      partner?.visualPosition &&
      distance(game.player.visualPosition, partner.visualPosition) <= GESTURE_DISTANCE
    ) {
      this.gesture = { startedAt: now, local: game.player, partner };
    }
  }

  updateGesture(game, now) {
    if (!this.gesture) return;
    if (game.settings?.reducedMotion) {
      this.clearGesture();
      return;
    }

    const age = now - this.gesture.startedAt;
    if (age < 0) return;
    if (age >= GESTURE_DURATION_MS) {
      this.clearGesture();
      return;
    }
    const weight = gestureWeight(this.gesture.startedAt, now);

    const { local, partner } = this.gesture;
    const currentPartner = game.remotes?.values?.().next?.().value || null;
    if (
      currentPartner !== partner ||
      !local?.visualPosition ||
      !partner?.visualPosition ||
      distance(local.visualPosition, partner.visualPosition) > GESTURE_DISTANCE + 1
    ) {
      this.clearGesture();
      return;
    }

    applyGesture(local, partner.visualPosition, weight);
    applyGesture(partner, local.visualPosition, weight);
  }

  clearGesture() {
    if (!this.gesture) return;
    resetGesture(this.gesture.local);
    resetGesture(this.gesture.partner);
    this.gesture = null;
  }

  reset() {
    this.clearGesture();
    this.previous = null;
  }
}

export function installCoopCelebrationPresentation(options = {}) {
  const presentation = new CoopCelebrationPresentation(options);
  presentation.init();
  return presentation;
}
