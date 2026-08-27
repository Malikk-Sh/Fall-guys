import { COSMETIC_BY_ID, SLOT_META, SLOT_ORDER } from '/shared/cosmetics.js';
import { readCosmetics, readLoadoutPresets, saveLoadoutPreset } from '../core/cosmetics.js';
import { applyPresetLoadoutConfirmed } from '../core/PresetLoadout.js';

const STYLESHEET_ID = 'wardrobePresetUxStylesheet';

const hex = (value, fallback) =>
  `#${Number(Number.isFinite(value) ? value : fallback)
    .toString(16)
    .padStart(6, '0')
    .slice(-6)}`;

export function presetVisualModel(preset) {
  if (!preset) {
    return {
      empty: true,
      primary: '#6546d8',
      accent: '#48dcda',
      visor: '#dffcff',
      icons: []
    };
  }
  const body = COSMETIC_BY_ID[preset.body] || null;
  const visor = COSMETIC_BY_ID[preset.visor] || null;
  const primary = body?.render?.primary ?? body?.colors?.body ?? body?.render?.color;
  const accent = body?.render?.accent ?? body?.render?.secondary ?? body?.colors?.accent;
  const visorColor = visor?.render?.primary ?? visor?.color ?? visor?.render?.color;
  const icons = SLOT_ORDER.filter(slot => slot !== 'body' && preset[slot])
    .map(slot => SLOT_META[slot]?.icon)
    .filter(Boolean);
  return {
    empty: false,
    primary: hex(primary, 0x6546d8),
    accent: hex(accent, 0x48dcda),
    visor: hex(visorColor, 0xdffcff),
    icons
  };
}

function installStylesheet(root) {
  if (!root?.head || root.getElementById(STYLESHEET_ID)) return;
  const link = root.createElement('link');
  link.id = STYLESHEET_ID;
  link.rel = 'stylesheet';
  // Адрес считается от САМОГО МОДУЛЯ, а не от корня: абсолютный путь ломается и на подпути
  // площадки, и на глубоком маршруте нашего SPA. См. tools/buildPortal.mjs.
  link.href = new URL('../wardrobe-preset-ux.css', import.meta.url).href;
  root.head.append(link);
}

export class WardrobePresetPresentation {
  constructor({
    root = globalThis.document,
    windowRef = globalThis,
    getWardrobe = () => globalThis.__WOBBLE_GAME__?.ui?.wardrobe
  } = {}) {
    this.root = root;
    this.window = windowRef;
    this.getWardrobe = getWardrobe;
    this.host = null;
    this.observer = null;
    this.confirmOverwrite = null;
    this.applying = null;
    this.applied = null;
    this.failed = null;
    this.boundClick = event => this.handleClick(event);
  }

  init() {
    if (!this.root?.body) return this;
    installStylesheet(this.root);
    const Observer = this.window?.MutationObserver || globalThis.MutationObserver;
    if (Observer) {
      this.observer = new Observer(() => this.sync());
      this.observer.observe(this.root.body, { childList: true, subtree: true });
    }
    this.sync();
    return this;
  }

  destroy() {
    this.host?.removeEventListener?.('click', this.boundClick, true);
    this.observer?.disconnect?.();
    this.observer = null;
    this.host = null;
  }

  sync() {
    const host = this.root?.getElementById?.('wardrobePresets');
    if (!host) return;
    if (host !== this.host) {
      this.host?.removeEventListener?.('click', this.boundClick, true);
      this.host = host;
      this.host.className = 'wardrobe-presets-enhanced';
      this.host.removeAttribute('style');
      this.host.addEventListener('click', this.boundClick, true);
    }
    if (!this.host.querySelector('.wardrobe-preset-grid')) this.render();
  }

  render() {
    if (!this.host) return;
    const presets = readLoadoutPresets();
    const title = this.root.createElement('small');
    title.className = 'wardrobe-preset-title';
    title.textContent = 'БЫСТРЫЕ ОБРАЗЫ';
    const grid = this.root.createElement('div');
    grid.className = 'wardrobe-preset-grid';

    presets.forEach((preset, index) => grid.append(this.buildCard(preset, index)));
    this.host.replaceChildren(title, grid);
  }

  buildCard(preset, index) {
    const card = this.root.createElement('article');
    card.className = 'wardrobe-preset-card';
    card.classList.toggle('is-empty', !preset);
    card.classList.toggle('is-applying', this.applying === index);
    card.classList.toggle('is-applied', this.applied === index);
    card.classList.toggle('is-failed', this.failed === index);

    const apply = this.root.createElement('button');
    apply.type = 'button';
    apply.className = 'wardrobe-preset-apply';
    apply.dataset.presetApply = String(index);
    apply.disabled = !preset || this.applying !== null;
    const visual = presetVisualModel(preset);
    apply.style.setProperty('--preset-primary', visual.primary);
    apply.style.setProperty('--preset-accent', visual.accent);
    apply.style.setProperty('--preset-visor', visual.visor);

    const avatar = this.root.createElement('span');
    avatar.className = 'wardrobe-preset-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.append(this.root.createElement('i'));

    const copy = this.root.createElement('span');
    copy.className = 'wardrobe-preset-copy';
    const name = this.root.createElement('strong');
    name.textContent = `ОБРАЗ ${index + 1}`;
    const state = this.root.createElement('small');
    if (this.applying === index) state.textContent = 'ПРИМЕНЯЕМ…';
    else if (this.applied === index) state.textContent = 'ОБРАЗ НАДЕТ';
    else if (this.failed === index) state.textContent = 'НЕ ПРИМЕНЁН';
    else state.textContent = preset ? 'НАЖМИТЕ, ЧТОБЫ НАДЕТЬ' : 'ПУСТО';
    copy.append(name, state);

    const icons = this.root.createElement('span');
    icons.className = 'wardrobe-preset-icons';
    if (visual.icons.length) {
      for (const icon of visual.icons) {
        const badge = this.root.createElement('i');
        badge.textContent = icon;
        icons.append(badge);
      }
    } else {
      const badge = this.root.createElement('i');
      badge.textContent = '·';
      icons.append(badge);
    }

    apply.append(avatar, copy, icons);

    const save = this.root.createElement('button');
    save.type = 'button';
    save.className = 'wardrobe-preset-save';
    save.dataset.presetSave = String(index);
    save.disabled = this.applying !== null;
    save.textContent = preset
      ? this.confirmOverwrite === index
        ? 'ПОДТВЕРДИТЬ'
        : 'ПЕРЕЗАПИСАТЬ'
      : 'СОХРАНИТЬ';
    card.append(apply, save);
    return card;
  }

  handleClick(event) {
    const apply = event.target.closest?.('[data-preset-apply]');
    const save = event.target.closest?.('[data-preset-save]');
    if (!apply && !save) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    if (apply) this.apply(Number(apply.dataset.presetApply));
    else this.save(Number(save.dataset.presetSave));
  }

  save(index) {
    const wardrobe = this.getWardrobe?.();
    if (!wardrobe || !Number.isInteger(index)) return;
    const presets = readLoadoutPresets();
    if (presets[index] && this.confirmOverwrite !== index) {
      this.confirmOverwrite = index;
      this.applied = null;
      this.failed = null;
      this.render();
      return;
    }
    const current = readCosmetics(wardrobe.progress, wardrobe.profile);
    saveLoadoutPreset(index, current);
    this.confirmOverwrite = null;
    this.applied = null;
    this.failed = null;
    wardrobe.sfx?.uiConfirm?.();
    this.render();
  }

  async apply(index) {
    const wardrobe = this.getWardrobe?.();
    const preset = readLoadoutPresets()[index];
    if (!wardrobe || !preset || this.applying !== null) return;
    this.applying = index;
    this.confirmOverwrite = null;
    this.applied = null;
    this.failed = null;
    this.render();

    const result = await applyPresetLoadoutConfirmed(preset, {
      progress: wardrobe.progress,
      profile: wardrobe.profile
    });
    this.applying = null;
    if (result.confirmed) {
      this.applied = index;
      wardrobe.sfx?.uiConfirm?.();
    } else {
      this.failed = index;
      wardrobe.onEquipError?.('Образ применён не полностью. Состояние обновлено.');
    }
    wardrobe.previewLoadout = null;
    wardrobe.render?.();
    wardrobe.onChange?.();
    this.render();
  }
}

export function installWardrobePresetPresentation(options = {}) {
  const presentation = new WardrobePresetPresentation(options);
  presentation.init();
  return presentation;
}
