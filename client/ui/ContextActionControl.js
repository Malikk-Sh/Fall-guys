const ACTION_PRESENTATION = Object.freeze({
  pickup: { label: 'ВЗЯТЬ', icon: '◇', tone: 'pickup' },
  throw: { label: 'БРОСИТЬ', icon: '↗', tone: 'throw' },
  insert: { label: 'ВСТАВИТЬ', icon: '◆', tone: 'insert' }
});

const BASE_PRESENTATION = Object.freeze({ label: 'РЫВОК', icon: '➤', tone: 'dive' });

export function contextActionPresentation(action) {
  return ACTION_PRESENTATION[action] || BASE_PRESENTATION;
}

// Presentation получает semantic action только из CoopController. Здесь нет pickup radius,
// расстояний до socket или любых других gameplay rules — если gameplay ничего не разрешил,
// UI показывает обычный рывок.
export function semanticContextAction(game) {
  if (
    !game?.running ||
    game.mode !== 'coop' ||
    game.spectating ||
    !game.player ||
    game.player.downed
  ) {
    return null;
  }
  const action = game.coopControl?.coreAction?.() || null;
  return Object.hasOwn(ACTION_PRESENTATION, action) ? action : null;
}

export function keyCodeLabel(code) {
  if (typeof code !== 'string' || !code) return 'SHIFT';
  const labels = {
    ShiftLeft: 'SHIFT',
    ShiftRight: 'SHIFT',
    Space: 'SPACE',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→'
  };
  if (labels[code]) return labels[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return code.replace(/Left$|Right$/, '').toUpperCase().slice(0, 10);
}

const STYLE = `
#dive.context-action {
  transition:
    transform 150ms ease,
    border-color 150ms ease,
    box-shadow 150ms ease,
    background 150ms ease;
}
#dive.context-action[data-context='pickup'] {
  border-color: rgba(95, 235, 255, 0.9);
  background: linear-gradient(145deg, rgba(44, 192, 224, 0.96), rgba(52, 113, 213, 0.96));
  box-shadow: 0 8px 26px rgba(65, 216, 255, 0.26);
}
#dive.context-action[data-context='throw'] {
  border-color: rgba(255, 222, 92, 0.92);
  background: linear-gradient(145deg, rgba(239, 174, 52, 0.96), rgba(218, 98, 61, 0.96));
  box-shadow: 0 8px 26px rgba(255, 191, 68, 0.26);
}
#dive.context-action[data-context='insert'] {
  border-color: rgba(119, 255, 196, 0.92);
  background: linear-gradient(145deg, rgba(45, 201, 150, 0.96), rgba(48, 142, 170, 0.96));
  box-shadow: 0 8px 26px rgba(90, 255, 196, 0.24);
}
#dive.context-action.context-action-pop {
  transform: scale(1.07);
}
#signatureHud[data-context-action]:not([data-context-action='']) {
  display: none !important;
}
.context-action-hint {
  position: fixed;
  z-index: 32;
  left: 50%;
  bottom: max(calc(34px + env(safe-area-inset-bottom)), 8vh);
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 11px;
  border: 1px solid rgba(255, 255, 255, 0.42);
  border-radius: 999px;
  background: rgba(31, 18, 76, 0.78);
  box-shadow: 0 8px 24px rgba(23, 14, 66, 0.22);
  color: #fff;
  pointer-events: none;
  backdrop-filter: blur(8px);
}
.context-action-hint kbd {
  min-width: 38px;
  padding: 3px 7px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.12);
  font: 900 10px/1 system-ui, sans-serif;
  text-align: center;
}
.context-action-hint strong {
  font: 950 11px/1 system-ui, sans-serif;
  letter-spacing: 0.08em;
}
body[data-input='touch'] .context-action-hint {
  display: none !important;
}
body.reduced-motion #dive.context-action,
body.reduced-motion #dive.context-action.context-action-pop {
  transition-duration: 0ms !important;
  transform: none !important;
}
`;

export class ContextActionControl {
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
    this.action = undefined;
    this.popTimer = 0;
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
    if (this.popTimer) this.window?.clearTimeout?.(this.popTimer);
    this.frame = 0;
    this.popTimer = 0;
    this.apply(null, false);
  }

  installMarkup() {
    if (!this.root.getElementById('contextActionStyle')) {
      const style = this.root.createElement('style');
      style.id = 'contextActionStyle';
      style.textContent = STYLE;
      this.root.head?.append(style);
    }
    if (!this.root.getElementById('contextActionHint')) {
      const hint = this.root.createElement('div');
      hint.id = 'contextActionHint';
      hint.className = 'context-action-hint hidden';
      hint.setAttribute('aria-hidden', 'true');
      const key = this.root.createElement('kbd');
      const label = this.root.createElement('strong');
      hint.append(key, label);
      this.root.body.append(hint);
    }
  }

  schedule() {
    if (!this.active || this.frame) return;
    this.frame = this.window?.requestAnimationFrame?.(() => {
      this.frame = 0;
      this.tick();
      this.schedule();
    });
  }

  tick() {
    const game = this.getGame?.();
    const action = semanticContextAction(game);
    if (action === this.action) {
      this.syncSignatureHud(action);
      return;
    }
    const first = this.action === undefined;
    this.action = action;
    this.apply(action, !first);
    this.syncSignatureHud(action);
    if (!first) game?.settings?.vibrate?.(0.12);
  }

  apply(action, animate = true) {
    const button = this.root?.getElementById?.('dive');
    const hint = this.root?.getElementById?.('contextActionHint');
    const presentation = contextActionPresentation(action);

    if (button) {
      const icon = button.querySelector('i');
      const label = button.querySelector('span');
      if (icon) icon.textContent = presentation.icon;
      if (label) label.textContent = presentation.label;
      button.classList.toggle('context-action', Boolean(action));
      button.dataset.context = action || '';
      button.setAttribute('aria-label', action ? presentation.label : 'Рывок');
      if (animate && action) this.pop(button);
    }

    if (!hint) return;
    hint.classList.toggle('hidden', !action);
    if (!action) return;
    const game = this.getGame?.();
    const key = game?.settings?.get?.('keys')?.dive?.[0];
    hint.querySelector('kbd').textContent = keyCodeLabel(key);
    hint.querySelector('strong').textContent = presentation.label;
  }

  syncSignatureHud(action) {
    const signature = this.root?.getElementById?.('signatureHud');
    if (!signature) return;
    signature.dataset.contextAction = action || '';
  }

  pop(button) {
    button.classList.remove('context-action-pop');
    void button.offsetWidth;
    button.classList.add('context-action-pop');
    if (this.popTimer) this.window?.clearTimeout?.(this.popTimer);
    this.popTimer = this.window?.setTimeout?.(() => {
      button.classList.remove('context-action-pop');
      this.popTimer = 0;
    }, 160);
  }
}

export function installContextActionControl(options = {}) {
  const control = new ContextActionControl(options);
  control.init();
  return control;
}
