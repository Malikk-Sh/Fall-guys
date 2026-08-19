const ACTION_PRESENTATION = Object.freeze({
  pickup: { label: 'ВЗЯТЬ', icon: '◇', tone: 'pickup' },
  throw: { label: 'БРОСИТЬ', icon: '↗', tone: 'throw' },
  insert: { label: 'ВСТАВИТЬ', icon: '◆', tone: 'insert' }
});
const BASE_PRESENTATION = Object.freeze({ label: 'РЫВОК', icon: '➤', tone: 'dive' });
const STYLESHEET_ID = 'coopUxStylesheet';

export function contextActionPresentation(action) {
  return ACTION_PRESENTATION[action] || BASE_PRESENTATION;
}

// Presentation получает semantic action только из CoopController. Здесь нет pickup radius,
// расстояний до socket или любых других gameplay rules — если gameplay ничего не разрешил,
// UI показывает обычный рывок.
export function semanticContextAction(game) {
  if (!game?.running || game.mode !== 'coop' || game.spectating || !game.player || game.player.downed) {
    return null;
  }
  const action = game.coopControl?.coreAction?.() || null;
  return Object.hasOwn(ACTION_PRESENTATION, action) ? action : null;
}

export function compactSignatureText(text) {
  if (typeof text !== 'string') return '';
  if (text.startsWith('ПОДСКАЗЧИК · ПОСЛЕДОВАТЕЛЬНОСТЬ:')) {
    return text.replace('ПОДСКАЗЧИК · ПОСЛЕДОВАТЕЛЬНОСТЬ:', 'ПОДСКАЗКА ·');
  }
  if (text.startsWith('ОПЕРАТОР · ВВЕДИТЕ СИМВОЛЫ НАПАРНИКА ·')) {
    return text.replace('ОПЕРАТОР · ВВЕДИТЕ СИМВОЛЫ НАПАРНИКА ·', 'ПОВТОРИ ·');
  }
  return text;
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
  return code
    .replace(/Left$|Right$/, '')
    .toUpperCase()
    .slice(0, 10);
}

function installStylesheet(root) {
  if (!root?.head || root.getElementById(STYLESHEET_ID)) return;
  const link = root.createElement('link');
  link.id = STYLESHEET_ID;
  link.rel = 'stylesheet';
  link.href = '/coop-ux.css';
  root.head.append(link);
}

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
    installStylesheet(this.root);
    this.installHint();
    this.root.getElementById('dive')?.classList.add('context-action-control');
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

  installHint() {
    if (this.root.getElementById('contextActionHint')) return;
    const hint = this.root.createElement('div');
    hint.id = 'contextActionHint';
    hint.className = 'context-action-hint hidden';
    hint.setAttribute('aria-hidden', 'true');
    hint.append(this.root.createElement('kbd'), this.root.createElement('strong'));
    this.root.body.append(hint);
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
      this.syncHint(action);
      this.syncSignatureHud(action);
      this.compactSignatureHud(action);
      return;
    }

    const first = this.action === undefined;
    this.action = action;
    this.apply(action, !first);
    this.syncSignatureHud(action);
    this.compactSignatureHud(action);
    if (!first) game?.settings?.vibrate?.(0.12);
  }

  apply(action, animate = true) {
    const button = this.root?.getElementById?.('dive');
    const presentation = contextActionPresentation(action);
    if (button) {
      const icon = button.querySelector('i');
      const label = button.querySelector('span');
      if (icon?.textContent !== presentation.icon) icon.textContent = presentation.icon;
      if (label?.textContent !== presentation.label) label.textContent = presentation.label;
      button.dataset.context = action || '';
      button.setAttribute('aria-label', action ? presentation.label : 'Рывок');
      if (animate && action) this.pop(button);
    }
    this.syncHint(action);
  }

  syncHint(action) {
    const hint = this.root?.getElementById?.('contextActionHint');
    if (!hint) return;
    hint.classList.toggle('hidden', !action);
    if (!action) return;

    const game = this.getGame?.();
    const presentation = contextActionPresentation(action);
    const key = keyCodeLabel(game?.settings?.get?.('keys')?.dive?.[0]);
    const keyNode = hint.querySelector('kbd');
    const labelNode = hint.querySelector('strong');
    if (keyNode?.textContent !== key) keyNode.textContent = key;
    if (labelNode?.textContent !== presentation.label) labelNode.textContent = presentation.label;
  }

  syncSignatureHud(action) {
    const signature = this.root?.getElementById?.('signatureHud');
    if (!signature) return;
    const value = action || '';
    if (signature.dataset.contextAction !== value) signature.dataset.contextAction = value;
  }

  compactSignatureHud(action) {
    if (action) return;
    const signature = this.root?.getElementById?.('signatureHud');
    const copy = signature?.firstElementChild;
    if (!copy?.textContent) return;
    const compact = compactSignatureText(copy.textContent);
    if (compact !== copy.textContent) copy.textContent = compact;
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
