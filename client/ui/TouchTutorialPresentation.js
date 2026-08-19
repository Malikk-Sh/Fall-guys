import { isTouchMobile } from './MobileExperience.js';

export const TOUCH_TUTORIAL_STORAGE_KEY = 'wobble-touch-tutorial-v1';
const STEP_ORDER = Object.freeze(['move', 'look', 'jump', 'dive']);
const DIVE_HINT_DELAY_MS = 520;
const LOOK_DISTANCE_PX = 14;
const MOVE_THRESHOLD = 0.16;
const STYLESHEET_ID = 'touchTutorialStylesheet';

const STEP_COPY = Object.freeze({
  move: ['ДВИЖЕНИЕ', 'Потяните джойстик'],
  look: ['ОБЗОР', 'Проведите пальцем по трассе'],
  jump: ['ПРЫЖОК', 'Коснитесь кнопки прыжка'],
  dive: ['РЫВОК', 'В полёте используйте рывок']
});
const STEP_TARGET = Object.freeze({ move: 'stick', jump: 'jump', dive: 'dive' });

export function normalizeTouchTutorialSeen(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(STEP_ORDER.map(step => [step, source[step] === true]));
}

export function nextTouchTutorialStep(seen = {}) {
  const normalized = normalizeTouchTutorialSeen(seen);
  return STEP_ORDER.find(step => !normalized[step]) || null;
}

function storageFor(windowRef) {
  try {
    return windowRef?.localStorage || null;
  } catch {
    return null;
  }
}

function readSeen(storage) {
  try {
    const raw = storage?.getItem?.(TOUCH_TUTORIAL_STORAGE_KEY);
    return normalizeTouchTutorialSeen(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeTouchTutorialSeen();
  }
}

function writeSeen(storage, seen) {
  try {
    storage?.setItem?.(TOUCH_TUTORIAL_STORAGE_KEY, JSON.stringify(normalizeTouchTutorialSeen(seen)));
  } catch {
    // The current session still progresses when persistent storage is unavailable.
  }
}

function installStylesheet(root) {
  if (!root?.head || root.getElementById(STYLESHEET_ID)) return;
  const link = root.createElement('link');
  link.id = STYLESHEET_ID;
  link.rel = 'stylesheet';
  link.href = '/touch-tutorial.css';
  root.head.append(link);
}

export class TouchTutorialPresentation {
  constructor({
    root = globalThis.document,
    windowRef = globalThis,
    storage = null,
    getGame = () => globalThis.__WOBBLE_GAME__
  } = {}) {
    this.root = root;
    this.window = windowRef;
    this.storage = storage ?? storageFor(windowRef);
    this.getGame = getGame;
    this.seen = readSeen(this.storage);
    this.currentStep = null;
    this.active = false;
    this.observer = null;
    this.diveTimer = 0;
    this.diveReady = false;
    this.lookPointerId = null;
    this.lookStartX = 0;
    this.lookStartY = 0;
    this.boundPointerDown = event => this.onPointerDown(event);
    this.boundPointerMove = event => this.onPointerMove(event);
    this.boundPointerEnd = event => this.onPointerEnd(event);
  }

  get touchMobile() {
    const coarse = this.window?.matchMedia?.('(pointer: coarse)').matches === true;
    const hoverNone = this.window?.matchMedia?.('(hover: none)').matches === true;
    const maxTouchPoints = this.window?.navigator?.maxTouchPoints || 0;
    return isTouchMobile({ coarse, hoverNone, maxTouchPoints });
  }

  init() {
    if (this.active || !this.root?.body) return this;
    this.active = true;
    installStylesheet(this.root);
    this.installMarkup();
    if (this.touchMobile) this.root.getElementById('lookHint')?.classList.add('hidden');

    this.root.addEventListener('pointerdown', this.boundPointerDown);
    this.root.addEventListener('pointermove', this.boundPointerMove);
    this.root.addEventListener('pointerup', this.boundPointerEnd);
    this.root.addEventListener('pointercancel', this.boundPointerEnd);

    const Observer = this.window?.MutationObserver || globalThis.MutationObserver;
    if (typeof Observer === 'function') {
      this.observer = new Observer(() => this.sync());
      for (const id of ['hud', 'countdown', 'menu', 'finish', 'touch']) {
        const node = this.root.getElementById(id);
        if (node) this.observer.observe(node, { attributes: true, attributeFilter: ['class'] });
      }
    }
    this.sync();
    return this;
  }

  destroy() {
    if (!this.active) return;
    this.active = false;
    this.root?.removeEventListener?.('pointerdown', this.boundPointerDown);
    this.root?.removeEventListener?.('pointermove', this.boundPointerMove);
    this.root?.removeEventListener?.('pointerup', this.boundPointerEnd);
    this.root?.removeEventListener?.('pointercancel', this.boundPointerEnd);
    this.observer?.disconnect?.();
    this.observer = null;
    this.clearDiveTimer();
    this.clearFocus();
    this.hide();
  }

  installMarkup() {
    if (this.root.getElementById('touchTutorial')) return;
    const node = this.root.createElement('div');
    node.id = 'touchTutorial';
    node.className = 'touch-tutorial hidden';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.innerHTML = '<strong></strong><small></small>';
    this.root.body.append(node);
  }

  gameplayActive() {
    const game = this.getGame?.();
    if (!this.touchMobile || game?.state?.name !== 'race') return false;
    const hud = this.root?.getElementById?.('hud');
    const touch = this.root?.getElementById?.('touch');
    if (!hud || hud.classList.contains('hidden')) return false;
    if (!touch || touch.classList.contains('hidden')) return false;
    return true;
  }

  sync() {
    this.root?.getElementById?.('lookHint')?.classList.add('hidden');
    if (!this.gameplayActive()) {
      this.clearFocus();
      this.hide();
      return null;
    }

    const step = nextTouchTutorialStep(this.seen);
    if (!step) {
      this.clearFocus();
      this.hide();
      return null;
    }

    if (step === 'dive' && !this.diveReady) {
      this.scheduleDiveHint();
      this.clearFocus();
      this.hide();
      return step;
    }

    this.render(step);
    return step;
  }

  render(step) {
    const node = this.root?.getElementById?.('touchTutorial');
    if (!node || !STEP_COPY[step]) return;
    this.currentStep = step;
    node.dataset.step = step;
    node.querySelector('strong').textContent = STEP_COPY[step][0];
    node.querySelector('small').textContent = STEP_COPY[step][1];
    node.classList.remove('hidden');
    this.applyFocus(step);
  }

  hide() {
    const node = this.root?.getElementById?.('touchTutorial');
    node?.classList.add('hidden');
    if (node) delete node.dataset.step;
    this.currentStep = null;
  }

  complete(step) {
    if (!STEP_ORDER.includes(step) || nextTouchTutorialStep(this.seen) !== step) return false;
    this.seen[step] = true;
    writeSeen(this.storage, this.seen);
    this.clearFocus();
    if (step === 'jump') {
      this.diveReady = false;
      this.scheduleDiveHint();
    }
    if (step === 'dive') this.clearDiveTimer();
    this.sync();
    return true;
  }

  scheduleDiveHint() {
    if (this.diveReady || this.diveTimer || nextTouchTutorialStep(this.seen) !== 'dive') return;
    const setTimer = this.window?.setTimeout || globalThis.setTimeout;
    if (typeof setTimer !== 'function') {
      this.diveReady = true;
      this.sync();
      return;
    }
    this.diveTimer = setTimer(() => {
      this.diveTimer = 0;
      this.diveReady = true;
      this.sync();
    }, DIVE_HINT_DELAY_MS);
  }

  clearDiveTimer() {
    const clearTimer = this.window?.clearTimeout || globalThis.clearTimeout;
    if (this.diveTimer) clearTimer?.(this.diveTimer);
    this.diveTimer = 0;
  }

  applyFocus(step) {
    this.clearFocus();
    const targetId = STEP_TARGET[step];
    const target = targetId ? this.root.getElementById(targetId) : null;
    target?.classList.add('touch-tutorial-focus');
    if (step !== 'move' || !target || target.querySelector('.touch-tutorial-thumb')) return;
    const thumb = this.root.createElement('i');
    thumb.className = 'touch-tutorial-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    target.append(thumb);
  }

  clearFocus() {
    for (const node of this.root?.querySelectorAll?.('.touch-tutorial-focus') || []) {
      node.classList.remove('touch-tutorial-focus');
    }
    for (const node of this.root?.querySelectorAll?.('.touch-tutorial-thumb') || []) node.remove();
  }

  onPointerDown(event) {
    if (event.pointerType !== 'touch') return;
    this.sync();
    const step = nextTouchTutorialStep(this.seen);
    if (!step || !this.gameplayActive()) return;

    if (step === 'look' && event.target?.tagName === 'CANVAS') {
      this.lookPointerId = event.pointerId;
      this.lookStartX = event.clientX;
      this.lookStartY = event.clientY;
      return;
    }
    if (step === 'jump' && event.target?.closest?.('#jump')) this.complete('jump');
    if (step === 'dive' && event.target?.closest?.('#dive')) this.complete('dive');
  }

  onPointerMove(event) {
    if (event.pointerType !== 'touch' || !this.gameplayActive()) return;
    const step = nextTouchTutorialStep(this.seen);
    if (step === 'move' && event.target?.closest?.('#stick, #stickZone')) {
      const magnitude = Number(this.getGame?.()?.input?.movement?.().magnitude) || 0;
      if (magnitude >= MOVE_THRESHOLD) this.complete('move');
      return;
    }
    if (step !== 'look' || event.pointerId !== this.lookPointerId) return;
    const distance = Math.hypot(event.clientX - this.lookStartX, event.clientY - this.lookStartY);
    if (distance >= LOOK_DISTANCE_PX) this.complete('look');
  }

  onPointerEnd(event) {
    if (event.pointerId !== this.lookPointerId) return;
    this.lookPointerId = null;
  }
}

export function installTouchTutorialPresentation(options = {}) {
  if (globalThis.__WOBBLE_TOUCH_TUTORIAL__) return globalThis.__WOBBLE_TOUCH_TUTORIAL__;
  const presentation = new TouchTutorialPresentation(options);
  globalThis.__WOBBLE_TOUCH_TUTORIAL__ = presentation;
  presentation.init();
  return presentation;
}
