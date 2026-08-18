import { COLORS, courseSpec } from '../core/Config.js';
import { Player } from '../game/Player.js';
import { campaignThemeFor } from '../game/CampaignPresentation.js';
import { COOP_CHAPTERS, coopSpec } from '/shared/coopChapters.js';
import { ScreenTransitions } from './ScreenTransitions.js';

const $ = selector => document.querySelector(selector);
const PREVIEW_IDS = Object.freeze(['__menu-preview-1', '__menu-preview-2', '__menu-preview-3']);
const DEFAULT_SCENE = Object.freeze({
  background: 0x83dff0,
  fog: 0x93e5ef,
  fogNear: 42,
  fogFar: 145,
  sun: 0xfff7dc,
  sunIntensity: 2.85,
  exposure: 1.08,
  accent: 0x4ce0df,
  secondary: 0xffdd4c
});

const MODE_COPY = Object.freeze({
  single: Object.freeze({
    eyebrow: 'LIVE PREVIEW · SOLO',
    title: 'ВАША ТРАССА',
    detail: 'Один Wobbler, чистая трасса и выбранная сложность.'
  }),
  multi: Object.freeze({
    eyebrow: 'LIVE PREVIEW · RACE',
    title: 'СТАРТОВАЯ СЕТКА',
    detail: 'Декоративные соперники показывают масштаб — сеть ещё не подключается.'
  }),
  coop: Object.freeze({
    eyebrow: 'LIVE PREVIEW · CO-OP',
    title: 'ДВА WOBBLER',
    detail: 'Выбранная глава меняет мир и сцену без запуска серверного матча.'
  })
});

function hexColor(value, fallback) {
  const number = Number.isFinite(value) ? value : fallback;
  return `#${number.toString(16).padStart(6, '0').slice(-6)}`;
}

function visibleMenuMode(ui) {
  if (ui?.mode && ['single', 'multi', 'coop'].includes(ui.mode)) return ui.mode;
  for (const id of ['single', 'multi', 'coop']) {
    if (!$(`#${id}`)?.classList.contains('hidden')) return id;
  }
  return 'single';
}

export class MenuStageExperience {
  constructor({ root = document, windowRef = globalThis } = {}) {
    this.root = root;
    this.window = windowRef;
    this.game = null;
    this.transitions = null;
    this.previewFrame = 0;
    this.waitFrame = 0;
    this.waitAttempts = 0;
    this.gridObserver = null;
    this.lastChapterId = '';
    this.lastPreviewSignature = '';
    this.originalSelectMode = null;
    this.initialized = false;
  }

  init() {
    if (this.initialized || !this.root?.body) return this;
    this.initialized = true;
    this.installStylesheet();
    this.installShell();
    this.waitForGame();
    return this;
  }

  installStylesheet() {
    if (this.root.querySelector('link[data-menu-ux]')) return;
    const link = this.root.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/menu-ux.css';
    link.dataset.menuUx = '1';
    this.root.head.append(link);
  }

  installShell() {
    const menu = $('#menu');
    const tabs = menu?.querySelector('.mode-tabs');
    if (!menu || !tabs) return;
    this.root.body.classList.add('menu-stage-experience');

    if (!$('#menuModeRail')) {
      const rail = this.root.createElement('nav');
      rail.id = 'menuModeRail';
      rail.className = 'menu-mode-rail';
      rail.setAttribute('aria-label', 'Режим игры');
      const label = this.root.createElement('small');
      label.textContent = 'РЕЖИМ';
      rail.append(label, tabs);
      menu.insertBefore(rail, menu.firstElementChild);
    }

    if (!$('#menuPreviewCaption')) {
      const caption = this.root.createElement('aside');
      caption.id = 'menuPreviewCaption';
      caption.className = 'menu-preview-caption';
      caption.setAttribute('aria-hidden', 'true');
      caption.innerHTML = '<small></small><strong></strong><span></span>';
      menu.append(caption);
    }

    const campaign = $('#coopCampaign');
    if (campaign && !$('#campaignContext')) {
      const context = this.root.createElement('section');
      context.id = 'campaignContext';
      context.className = 'campaign-context';
      context.setAttribute('aria-live', 'polite');
      context.innerHTML = `
        <div class="campaign-context-copy">
          <strong id="campaignContextTitle"></strong>
          <small id="campaignContextSubtitle"></small>
        </div>
        <div id="campaignContextMeta" class="campaign-context-meta"></div>
        <div id="campaignContextMechanics" class="campaign-context-mechanics"></div>`;
      campaign.after(context);
    }

    this.syncCaption('single');
  }

  waitForGame() {
    const game = this.window?.__WOBBLE_GAME__;
    if (game?.ui?.coopChapters?.length) {
      this.attachGame(game);
      return;
    }
    if (this.root?.querySelector?.('#error:not(.hidden)')) return;
    if (this.waitAttempts++ > 600) return;
    this.waitFrame = this.window?.requestAnimationFrame?.(() => this.waitForGame()) || 0;
  }

  attachGame(game) {
    if (this.game === game) return;
    this.game = game;
    this.transitions = new ScreenTransitions({
      windowRef: this.window,
      getReducedMotion: () => Boolean(game.ui?.settings?.reducedMotion || game.settings?.reducedMotion)
    });
    this.wrapModeSelection();
    this.observeCampaign();
    $('#raceDifficulty')?.addEventListener('change', () => {
      if (visibleMenuMode(game.ui) === 'multi') this.schedulePreview('multi');
    });
    $('#runType')?.addEventListener('change', () => this.syncCaption('single'));
    $('#difficulty')?.addEventListener('change', () => this.syncCaption('single'));
    this.syncCampaignContext();
    const mode = visibleMenuMode(game.ui);
    this.syncMode(mode);
  }

  wrapModeSelection() {
    const ui = this.game?.ui;
    if (!ui || ui.__menuStageModeBound) return;
    ui.__menuStageModeBound = true;
    const original = ui.selectMode.bind(ui);
    this.originalSelectMode = original;
    ui.selectMode = mode => {
      const result = original(mode);
      this.syncMode(mode);
      return result;
    };
  }

  observeCampaign() {
    const grid = $('#coopCampaign');
    const Observer = this.window?.MutationObserver || globalThis.MutationObserver;
    if (!grid || typeof Observer !== 'function') return;
    this.gridObserver?.disconnect?.();
    this.gridObserver = new Observer(() => this.syncCampaignContext());
    this.gridObserver.observe(grid, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
  }

  syncMode(mode) {
    if (!['single', 'multi', 'coop'].includes(mode)) return;
    this.root.body.dataset.menuMode = mode;
    this.syncCaption(mode);
    this.transitions?.celebrate($('#menuPreviewCaption'), 'card');
    if (mode === 'coop') this.syncCampaignContext();
    this.schedulePreview(mode);
  }

  syncCaption(mode) {
    const caption = $('#menuPreviewCaption');
    const copy = MODE_COPY[mode] || MODE_COPY.single;
    if (!caption) return;
    caption.querySelector('small').textContent = copy.eyebrow;
    caption.querySelector('strong').textContent = copy.title;
    caption.querySelector('span').textContent = copy.detail;
  }

  syncCampaignContext() {
    const grid = $('#coopCampaign');
    const context = $('#campaignContext');
    if (!grid || !context) return;
    const selected = grid.querySelector('.campaign-card.selected') || grid.querySelector('.campaign-card');
    if (!selected) return;
    const chapterId = selected.dataset.chapter || COOP_CHAPTERS[0]?.id || '';
    const chapter = COOP_CHAPTERS.find(item => item.id === chapterId) || COOP_CHAPTERS[0];
    if (!chapter) return;

    $('#campaignContextTitle').textContent = chapter.title;
    $('#campaignContextSubtitle').textContent = chapter.subtitle;
    const medal = selected.querySelector('.campaign-medal')?.textContent?.trim() || '○ НЕ ПРОЙДЕНА';
    const best = selected.querySelector('.campaign-stats small:first-child b')?.textContent?.trim() || '—';
    $('#campaignContextMeta').textContent = `${medal} · ${best === '—' ? 'БЕЗ РЕКОРДА' : `ЛУЧШЕЕ ${best}`}`;

    const mechanics = $('#campaignContextMechanics');
    mechanics.replaceChildren();
    const labels = [...selected.querySelectorAll('.campaign-preview i')]
      .map(node => node.textContent?.trim())
      .filter(Boolean)
      .slice(0, 3);
    for (const label of labels) {
      const item = this.root.createElement('i');
      item.textContent = label;
      mechanics.append(item);
    }

    const changed = chapterId !== this.lastChapterId;
    this.lastChapterId = chapterId;
    if (changed) {
      this.transitions?.celebrate(context, 'card');
      if (visibleMenuMode(this.game?.ui) === 'coop') this.schedulePreview('coop');
    }
  }

  schedulePreview(mode) {
    if (!this.game || this.game.running) return;
    if (this.previewFrame) this.window?.cancelAnimationFrame?.(this.previewFrame);
    this.previewFrame =
      this.window?.requestAnimationFrame?.(() => {
        this.previewFrame = 0;
        this.renderPreview(mode);
      }) || 0;
    if (!this.previewFrame) this.renderPreview(mode);
  }

  previewSignature(mode) {
    if (mode === 'coop') return `coop:${this.lastChapterId || this.game?.ui?.coopChapter?.() || 'ch1'}`;
    if (mode === 'multi') {
      const difficulty = $('#raceDifficulty')?.value || 'normal';
      return `multi:${this.game?.menuRandomSeed || 0}:${difficulty}`;
    }
    const spec = this.game?.previewSpec;
    return `single:${spec?.seed || 0}:${spec?.difficulty || 'normal'}`;
  }

  renderPreview(mode) {
    const game = this.game;
    if (!game || game.running || game.state?.name !== 'menu') return;
    const signature = this.previewSignature(mode);
    if (signature === this.lastPreviewSignature && this.root.body.dataset.menuPreviewMode === mode) return;
    this.lastPreviewSignature = signature;

    if (mode === 'coop') {
      const chapterId = this.lastChapterId || game.ui?.coopChapter?.() || COOP_CHAPTERS[0]?.id;
      const spec = coopSpec(chapterId);
      game.buildPreview(spec);
      this.addPreviewActor(1, COLORS.cyan);
      game.camera.position.set(9, 6.2, 15);
      game.camera.lookAt(0, 1, -7);
      this.applyCampaignTheme(chapterId);
      this.root.body.dataset.menuPreviewChapter = chapterId;
    } else if (mode === 'multi') {
      const difficulty = $('#raceDifficulty')?.value || 'normal';
      const spec = courseSpec(game.menuRandomSeed, difficulty);
      game.buildPreview(spec);
      this.addPreviewActor(1, COLORS.cyan);
      this.addPreviewActor(2, COLORS.orange);
      this.addPreviewActor(3, COLORS.yellow);
      game.camera.position.set(12, 6.8, 18);
      game.camera.lookAt(0, 1, -8);
      this.restoreDefaultTheme();
      delete this.root.body.dataset.menuPreviewChapter;
    } else {
      game.buildPreview(game.previewSpec);
      this.restoreDefaultTheme();
      delete this.root.body.dataset.menuPreviewChapter;
    }

    this.root.body.dataset.menuPreviewMode = mode;
  }

  addPreviewActor(index, color) {
    const game = this.game;
    if (!game?.course || !game?.scene) return null;
    const id = PREVIEW_IDS[index - 1] || `__menu-preview-${index}`;
    const actor = new Player(game.scene, game.course, game.effects, {
      remote: true,
      color,
      accent: COLORS.yellow,
      cosmetics: game.ui?.cosmeticLoadout?.()
    });
    actor.teleport(game.course.spawnFor(index));
    game.remotes.set(id, actor);
    return actor;
  }

  applyCampaignTheme(chapterId) {
    const theme = campaignThemeFor(chapterId);
    if (!theme || !this.game) return this.restoreDefaultTheme();
    const game = this.game;
    game.scene?.background?.setHex?.(theme.background);
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
    this.root.documentElement.style.setProperty(
      '--world-accent',
      hexColor(theme.accent, DEFAULT_SCENE.accent)
    );
    this.root.documentElement.style.setProperty(
      '--world-secondary',
      hexColor(theme.secondary, DEFAULT_SCENE.secondary)
    );
    this.root.documentElement.style.setProperty(
      '--world-glow',
      `${hexColor(theme.accent, DEFAULT_SCENE.accent)}55`
    );
    const caption = $('#menuPreviewCaption');
    if (caption) {
      caption.querySelector('small').textContent = `LIVE PREVIEW · ${theme.world}`;
      caption.querySelector('strong').textContent =
        COOP_CHAPTERS.find(item => item.id === chapterId)?.title || MODE_COPY.coop.title;
    }
  }

  restoreDefaultTheme() {
    const game = this.game;
    if (!game) return;
    game.scene?.background?.setHex?.(DEFAULT_SCENE.background);
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
    this.root.documentElement.style.setProperty('--world-accent', hexColor(DEFAULT_SCENE.accent));
    this.root.documentElement.style.setProperty('--world-secondary', hexColor(DEFAULT_SCENE.secondary));
    this.root.documentElement.style.setProperty('--world-glow', `${hexColor(DEFAULT_SCENE.accent)}4d`);
    this.syncCaption(visibleMenuMode(game.ui));
  }
}

export function installMenuStageExperience() {
  if (globalThis.__WOBBLE_MENU_STAGE__) return globalThis.__WOBBLE_MENU_STAGE__;
  const experience = new MenuStageExperience();
  globalThis.__WOBBLE_MENU_STAGE__ = experience;
  experience.init();
  return experience;
}
