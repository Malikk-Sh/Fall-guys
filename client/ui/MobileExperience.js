const FULLSCREEN_PROMPT_KEY = 'wobble-fullscreen-prompt-v1';
const GAMEPLAY_INPUT_STATES = new Set(['race', 'spectate']);
const MAX_GAME_WAIT_FRAMES = 300;

export function isTouchMobile({ coarse = false, hoverNone = false, maxTouchPoints = 0 } = {}) {
  return Boolean(coarse || (hoverNone && Number(maxTouchPoints) > 0));
}

export function mobileOrientationState({ mobile, width, height, portraitOverride = false } = {}) {
  const safeWidth = Math.max(0, Number(width) || 0);
  const safeHeight = Math.max(0, Number(height) || 0);
  const landscape = safeWidth >= safeHeight;
  return {
    mobile: Boolean(mobile),
    landscape,
    blocked: Boolean(mobile && !landscape && !portraitOverride)
  };
}

export function gameplayInputAllowed(stateName) {
  return GAMEPLAY_INPUT_STATES.has(stateName);
}

function storageFor(windowRef) {
  try {
    return windowRef?.localStorage || null;
  } catch {
    return null;
  }
}

function readFlag(storage, key) {
  try {
    return storage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(storage, key) {
  try {
    storage?.setItem(key, '1');
  } catch {
    // Storage may be unavailable in private/embedded contexts. The current session still works.
  }
}

export class MobileExperience {
  constructor({ root = globalThis.document, windowRef = globalThis, storage = null } = {}) {
    this.root = root;
    this.window = windowRef;
    this.storage = storage ?? storageFor(windowRef);
    this.initialized = false;
    this.destroyed = false;
    this.portraitOverride = false;
    this.lastBlocked = false;
    this.game = null;
    this.settings = null;
    this.unsubscribeSettings = null;
    this.gameWaitFrame = 0;
    this.gameWaitAttempts = 0;
    this.orientationFrame = 0;
    this.menuObserver = null;
    this.fullscreenPromptArmed = false;
    this.fullscreenPromptGestureActive = false;
    this.fullscreenPromptReleaseTimer = 0;

    this.onFullscreenChange = () => this.updateFullscreen();
    this.onFullscreenError = () => this.updateFullscreen();
    this.onOrientationSignal = () => this.scheduleOrientationUpdate();
    this.onVisibilityChange = () => {
      if (!this.root?.hidden) this.scheduleOrientationUpdate();
    };
    this.onBlockedKeyboard = event => {
      if (!this.portraitBlocked) return;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation?.();
    };
    this.onMenuPointerDown = event => {
      const button = event.target?.closest?.('.mode-tab');
      const menu = this.root?.querySelector?.('#menu');
      if (!button || !menu?.contains?.(button)) return;
      const clearTimer = this.window?.clearTimeout || globalThis.clearTimeout;
      if (this.fullscreenPromptReleaseTimer) clearTimer?.(this.fullscreenPromptReleaseTimer);
      this.fullscreenPromptReleaseTimer = 0;
      this.fullscreenPromptGestureActive = true;
      this.syncFullscreenPrompt();
    };
    this.onMenuClick = event => {
      const button = event.target?.closest?.('.mode-tab');
      const menu = this.root?.querySelector?.('#menu');
      if (!button || !menu?.contains?.(button)) return;
      // The click has started delivery to the original mode button. Arm onboarding now, but keep
      // the overlay suppressed until the event finishes so it can never steal this activation.
      this.fullscreenPromptArmed = true;
      this.fullscreenPromptGestureActive = true;
      this.scheduleFullscreenPromptRelease();
    };
    this.onMenuPointerCancel = () => this.scheduleFullscreenPromptRelease();
  }

  get mobile() {
    return isTouchMobile({
      coarse: this.window?.matchMedia?.('(pointer: coarse)').matches === true,
      hoverNone: this.window?.matchMedia?.('(hover: none)').matches === true,
      maxTouchPoints: this.window?.navigator?.maxTouchPoints || 0
    });
  }

  get portraitBlocked() {
    return mobileOrientationState({
      mobile: this.mobile,
      ...this.viewport(),
      portraitOverride: this.portraitOverride
    }).blocked;
  }

  get fullscreen() {
    return Boolean(this.root?.fullscreenElement);
  }

  get fullscreenSupported() {
    return Boolean(this.root?.fullscreenEnabled && this.root?.documentElement?.requestFullscreen);
  }

  viewport() {
    const viewport = this.window?.visualViewport;
    return {
      width: viewport?.width || this.window?.innerWidth || this.root?.documentElement?.clientWidth || 0,
      height: viewport?.height || this.window?.innerHeight || this.root?.documentElement?.clientHeight || 0
    };
  }

  init() {
    if (this.initialized || !this.root?.body) return this;
    this.initialized = true;
    this.installMarkup();
    this.observeMenu();

    this.root.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.root.addEventListener('fullscreenerror', this.onFullscreenError);
    this.root.addEventListener('visibilitychange', this.onVisibilityChange);
    this.root.addEventListener('pointerdown', this.onMenuPointerDown, true);
    this.root.addEventListener('click', this.onMenuClick, true);
    this.root.addEventListener('pointercancel', this.onMenuPointerCancel, true);
    this.window?.addEventListener?.('resize', this.onOrientationSignal);
    this.window?.addEventListener?.('orientationchange', this.onOrientationSignal);
    this.window?.addEventListener?.('keydown', this.onBlockedKeyboard, true);
    this.window?.addEventListener?.('keyup', this.onBlockedKeyboard, true);
    this.window?.visualViewport?.addEventListener?.('resize', this.onOrientationSignal);
    this.window?.screen?.orientation?.addEventListener?.('change', this.onOrientationSignal);

    this.bindGameWhenReady();
    this.updateFullscreen();
    this.updateOrientation();
    return this;
  }

  destroy() {
    if (!this.initialized || this.destroyed) return;
    this.destroyed = true;
    this.root?.removeEventListener?.('fullscreenchange', this.onFullscreenChange);
    this.root?.removeEventListener?.('fullscreenerror', this.onFullscreenError);
    this.root?.removeEventListener?.('visibilitychange', this.onVisibilityChange);
    this.root?.removeEventListener?.('pointerdown', this.onMenuPointerDown, true);
    this.root?.removeEventListener?.('click', this.onMenuClick, true);
    this.root?.removeEventListener?.('pointercancel', this.onMenuPointerCancel, true);
    this.window?.removeEventListener?.('resize', this.onOrientationSignal);
    this.window?.removeEventListener?.('orientationchange', this.onOrientationSignal);
    this.window?.removeEventListener?.('keydown', this.onBlockedKeyboard, true);
    this.window?.removeEventListener?.('keyup', this.onBlockedKeyboard, true);
    this.window?.visualViewport?.removeEventListener?.('resize', this.onOrientationSignal);
    this.window?.screen?.orientation?.removeEventListener?.('change', this.onOrientationSignal);
    this.menuObserver?.disconnect?.();
    this.unsubscribeSettings?.();
    const clearTimer = this.window?.clearTimeout || globalThis.clearTimeout;
    if (this.fullscreenPromptReleaseTimer) clearTimer?.(this.fullscreenPromptReleaseTimer);
    if (this.gameWaitFrame) this.window?.cancelAnimationFrame?.(this.gameWaitFrame);
    if (this.orientationFrame) this.window?.cancelAnimationFrame?.(this.orientationFrame);
  }

  installMarkup() {
    if (!this.root.querySelector('#rotateDevice')) {
      const overlay = this.root.createElement('section');
      overlay.id = 'rotateDevice';
      overlay.className = 'rotate-device hidden';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-live', 'polite');
      overlay.innerHTML = `
        <div class="rotate-device-card">
          <div class="rotate-wobbler" aria-hidden="true"><i></i></div>
          <div class="rotate-phone" aria-hidden="true"><i></i></div>
          <span class="eyebrow">WOBBLE RUSH</span>
          <h2>ПОВЕРНИТЕ УСТРОЙСТВО</h2>
          <p>Для забега нужен горизонтальный экран — так трасса остаётся видимой, а управление не закрывает центр.</p>
          <button id="rotateAccessibility" class="text-button" type="button">НЕ МОГУ ПОВЕРНУТЬ УСТРОЙСТВО</button>
          <div id="rotateFallback" class="rotate-fallback hidden">
            <p>Можно продолжить вертикально. Интерфейс станет крупнее и компактнее, но игра, матч и подключение сохранятся.</p>
            <button id="portraitContinue" class="button button-secondary" type="button">ПРОДОЛЖИТЬ В PORTRAIT</button>
          </div>
        </div>`;
      this.root.body.append(overlay);
    }

    if (!this.root.querySelector('#mobileGameModePrompt')) {
      const prompt = this.root.createElement('section');
      prompt.id = 'mobileGameModePrompt';
      prompt.className = 'mobile-game-mode hidden';
      prompt.setAttribute('role', 'region');
      prompt.setAttribute('aria-labelledby', 'mobileGameModeTitle');
      prompt.innerHTML = `
        <div class="mobile-game-mode-card glass">
          <span class="eyebrow">WOBBLE RUSH</span>
          <h2 id="mobileGameModeTitle">ИГРАЙТЕ НА ВЕСЬ ЭКРАН</h2>
          <p>Landscape уже готов. Fullscreen уберёт браузерные панели, если устройство это поддерживает.</p>
          <button id="mobileFullscreenStart" class="button button-primary" type="button">ИГРАТЬ НА ВЕСЬ ЭКРАН</button>
          <button id="mobileBrowserContinue" class="button button-secondary" type="button">ПРОДОЛЖИТЬ В БРАУЗЕРЕ</button>
        </div>`;
      this.root.body.append(prompt);
    }

    const footer = this.root.querySelector('.menu-footer');
    if (footer && !this.root.querySelector('#fullscreenToggle')) {
      const button = this.root.createElement('button');
      button.id = 'fullscreenToggle';
      button.type = 'button';
      button.className = 'icon-button fullscreen-toggle hidden';
      button.textContent = '⛶';
      button.setAttribute('aria-label', 'Включить полноэкранный режим');
      footer.append(button);
    }

    this.root.querySelector('#rotateAccessibility')?.addEventListener('click', () => {
      this.root.querySelector('#rotateFallback')?.classList.remove('hidden');
    });
    this.root.querySelector('#portraitContinue')?.addEventListener('click', () => {
      this.portraitOverride = true;
      this.updateOrientation();
    });
    this.root.querySelector('#mobileFullscreenStart')?.addEventListener('click', () => this.enterGameMode());
    this.root
      .querySelector('#mobileBrowserContinue')
      ?.addEventListener('click', () => this.dismissFullscreenPrompt());
    this.root.querySelector('#fullscreenToggle')?.addEventListener('click', () => this.toggleFullscreen());
  }

  observeMenu() {
    const menu = this.root?.querySelector?.('#menu');
    const Observer = this.window?.MutationObserver || globalThis.MutationObserver;
    if (!menu || typeof Observer !== 'function') return;
    this.menuObserver?.disconnect?.();
    this.menuObserver = new Observer(() => this.syncFullscreenPrompt());
    this.menuObserver.observe(menu, { attributes: true, attributeFilter: ['class'] });
  }

  bindGameWhenReady() {
    const game = this.window?.__WOBBLE_GAME__;
    if (game) {
      this.bindGame(game);
      return;
    }
    if (this.destroyed || this.root?.querySelector?.('#error:not(.hidden)')) return;
    this.gameWaitAttempts += 1;
    if (this.gameWaitAttempts > MAX_GAME_WAIT_FRAMES) return;
    this.gameWaitFrame = this.window?.requestAnimationFrame?.(() => this.bindGameWhenReady()) || 0;
  }

  bindGame(game) {
    if (this.game === game) return;
    this.game = game;
    this.gameWaitAttempts = 0;
    this.settings = game?.settings || null;
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = this.settings?.subscribe?.(() => this.syncAccessibility()) || null;
    this.syncAccessibility();
    if (this.portraitBlocked) this.suspendGameInput();
  }

  syncAccessibility() {
    const reduced = Boolean(this.settings?.reducedMotion);
    this.root?.body?.classList.toggle('mobile-reduced-motion', reduced);
  }

  scheduleFullscreenPromptRelease() {
    if (!this.fullscreenPromptGestureActive) return;
    const clearTimer = this.window?.clearTimeout || globalThis.clearTimeout;
    const setTimer = this.window?.setTimeout || globalThis.setTimeout;
    if (this.fullscreenPromptReleaseTimer) clearTimer?.(this.fullscreenPromptReleaseTimer);
    if (typeof setTimer !== 'function') {
      this.fullscreenPromptGestureActive = false;
      this.syncFullscreenPrompt();
      return;
    }
    this.fullscreenPromptReleaseTimer = setTimer(() => {
      this.fullscreenPromptReleaseTimer = 0;
      this.fullscreenPromptGestureActive = false;
      this.syncFullscreenPrompt();
    }, 0);
  }

  scheduleOrientationUpdate() {
    if (this.orientationFrame) return;
    this.orientationFrame =
      this.window?.requestAnimationFrame?.(() => {
        this.orientationFrame = 0;
        this.updateOrientation();
      }) || 0;
    if (!this.orientationFrame) this.updateOrientation();
  }

  updateOrientation() {
    if (!this.root?.body) return;
    const state = mobileOrientationState({
      mobile: this.mobile,
      ...this.viewport(),
      portraitOverride: this.portraitOverride
    });
    const body = this.root.body;
    body.classList.toggle('mobile-experience', state.mobile);
    body.classList.toggle('mobile-landscape', state.mobile && state.landscape);
    body.classList.toggle('mobile-portrait', state.mobile && !state.landscape);
    body.classList.toggle('portrait-blocked', state.blocked);
    body.classList.toggle(
      'portrait-accessibility',
      state.mobile && !state.landscape && this.portraitOverride
    );
    body.dataset.mobileOrientation = state.mobile ? (state.landscape ? 'landscape' : 'portrait') : 'desktop';

    const overlay = this.root.querySelector('#rotateDevice');
    overlay?.classList.toggle('hidden', !state.blocked);
    overlay?.setAttribute('aria-hidden', String(!state.blocked));

    if (state.blocked && !this.lastBlocked) this.suspendGameInput();
    if (!state.blocked && this.lastBlocked) this.resumeGameInput();
    this.lastBlocked = state.blocked;

    if (!state.blocked) this.game?.resize?.();
    this.syncFullscreenPrompt();
    this.emit('wobble-orientation-change', state);
  }

  suspendGameInput() {
    const input = this.game?.input;
    if (!input) return;
    input.reset?.();
    input.enabled = false;
  }

  resumeGameInput() {
    const input = this.game?.input;
    if (!input) return;
    input.reset?.();
    input.enabled = gameplayInputAllowed(this.game?.state?.name);
  }

  async tryFullscreen() {
    if (this.fullscreen) return true;
    if (!this.fullscreenSupported) return false;
    try {
      await this.root.documentElement.requestFullscreen({ navigationUI: 'hide' });
      return true;
    } catch {
      return false;
    }
  }

  async tryOrientationLock() {
    try {
      const lock = this.window?.screen?.orientation?.lock;
      if (typeof lock !== 'function') return false;
      await lock.call(this.window.screen.orientation, 'landscape');
      return true;
    } catch {
      return false;
    }
  }

  async enterGameMode() {
    this.dismissFullscreenPrompt();
    const fullscreen = await this.tryFullscreen();
    await this.tryOrientationLock();
    return fullscreen;
  }

  async toggleFullscreen() {
    if (this.fullscreen) {
      try {
        await this.root.exitFullscreen?.();
        return true;
      } catch {
        return false;
      }
    }
    return this.enterGameMode();
  }

  updateFullscreen() {
    const button = this.root?.querySelector?.('#fullscreenToggle');
    if (button) {
      button.classList.toggle('hidden', !this.fullscreenSupported && !this.fullscreen);
      button.textContent = this.fullscreen ? '⛶×' : '⛶';
      button.setAttribute('aria-pressed', String(this.fullscreen));
      button.setAttribute(
        'aria-label',
        this.fullscreen ? 'Выйти из полноэкранного режима' : 'Включить полноэкранный режим'
      );
    }
    this.root?.body?.classList.toggle('is-fullscreen', this.fullscreen);
    this.syncFullscreenPrompt();
    this.emit('wobble-fullscreen-change', { fullscreen: this.fullscreen });
  }

  dismissFullscreenPrompt() {
    writeFlag(this.storage, FULLSCREEN_PROMPT_KEY);
    this.root?.querySelector?.('#mobileGameModePrompt')?.classList.add('hidden');
  }

  syncFullscreenPrompt() {
    const prompt = this.root?.querySelector?.('#mobileGameModePrompt');
    if (!prompt) return;
    const menu = this.root.querySelector('#menu');
    const dismissed = readFlag(this.storage, FULLSCREEN_PROMPT_KEY);
    const show =
      this.fullscreenPromptArmed &&
      this.mobile &&
      !this.portraitBlocked &&
      !this.fullscreen &&
      this.fullscreenSupported &&
      !dismissed &&
      !this.fullscreenPromptGestureActive &&
      menu &&
      !menu.classList.contains('hidden');
    prompt.classList.toggle('hidden', !show);
  }

  emit(name, detail) {
    try {
      const EventCtor = this.window?.CustomEvent || globalThis.CustomEvent;
      if (EventCtor) this.window?.dispatchEvent?.(new EventCtor(name, { detail }));
    } catch {
      // Presentation events are advisory and must never break the game shell.
    }
  }
}
