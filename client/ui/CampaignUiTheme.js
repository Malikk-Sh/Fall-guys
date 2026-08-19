import { campaignThemeFor } from '../game/CampaignPresentation.js';

const STYLESHEET_ID = 'acceptancePolishStylesheet';
const DEFAULT_UI_THEME = Object.freeze({ accent: 0x4ce0df, secondary: 0xffdd4c });

function hexColor(value, fallback) {
  const number = Number.isFinite(value) ? value : fallback;
  return `#${number.toString(16).padStart(6, '0').slice(-6)}`;
}

export function campaignUiTokens(chapterId) {
  const theme = campaignThemeFor(chapterId);
  const accent = hexColor(theme?.accent, DEFAULT_UI_THEME.accent);
  const secondary = hexColor(theme?.secondary, DEFAULT_UI_THEME.secondary);
  return {
    id: theme?.id || null,
    accent,
    secondary,
    glow: `${accent}4d`
  };
}

export function applyCampaignUiTokens(root, chapterId) {
  const tokens = campaignUiTokens(chapterId);
  const style = root?.documentElement?.style;
  style?.setProperty?.('--world-accent', tokens.accent);
  style?.setProperty?.('--world-secondary', tokens.secondary);
  style?.setProperty?.('--world-glow', tokens.glow);
  return tokens;
}

function installStylesheet(root) {
  if (!root?.head || root.getElementById(STYLESHEET_ID)) return;
  const link = root.createElement('link');
  link.id = STYLESHEET_ID;
  link.rel = 'stylesheet';
  link.href = '/acceptance-polish.css';
  root.head.append(link);
}

export class CampaignUiTheme {
  constructor({
    root = globalThis.document,
    windowRef = globalThis,
    getGame = () => globalThis.__WOBBLE_GAME__
  } = {}) {
    this.root = root;
    this.window = windowRef;
    this.getGame = getGame;
    this.observer = null;
    this.lastThemeId = undefined;
  }

  init() {
    if (!this.root?.body) return this;
    installStylesheet(this.root);
    const Observer = this.window?.MutationObserver || globalThis.MutationObserver;
    if (typeof Observer === 'function') {
      this.observer = new Observer(() => this.sync());
      for (const id of ['menu', 'lobby', 'finish', 'hud']) {
        const node = this.root.getElementById?.(id);
        if (node) this.observer.observe(node, { attributes: true, attributeFilter: ['class'] });
      }
    }
    this.sync();
    return this;
  }

  destroy() {
    this.observer?.disconnect?.();
    this.observer = null;
  }

  sync() {
    const menu = this.root?.getElementById?.('menu');
    if (menu && !menu.classList.contains('hidden')) {
      delete this.root.body.dataset.campaignUiTheme;
      this.lastThemeId = undefined;
      return null;
    }

    const hud = this.root?.getElementById?.('hud');
    const game = this.getGame?.();
    const chapterId =
      hud && !hud.classList.contains('hidden') && game?.mode === 'coop'
        ? game.course?.spec?.chapterId || null
        : null;
    const tokens = campaignUiTokens(chapterId);
    if (tokens.id === this.lastThemeId) return tokens;

    applyCampaignUiTokens(this.root, chapterId);
    if (tokens.id) this.root.body.dataset.campaignUiTheme = tokens.id;
    else delete this.root.body.dataset.campaignUiTheme;
    this.lastThemeId = tokens.id;
    return tokens;
  }
}

export function installCampaignUiTheme(options = {}) {
  if (globalThis.__WOBBLE_CAMPAIGN_UI_THEME__) return globalThis.__WOBBLE_CAMPAIGN_UI_THEME__;
  const presentation = new CampaignUiTheme(options);
  globalThis.__WOBBLE_CAMPAIGN_UI_THEME__ = presentation;
  presentation.init();
  return presentation;
}
