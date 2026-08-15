import {
  COSMETIC_BY_ID,
  COLLECTIONS,
  EMOTE_LOADOUT_SIZE,
  EMOTE_SLOT,
  RARITY_META,
  SLOT_META,
  SLOT_ORDER,
  rarityMeta
} from '/shared/cosmetics.js';
import { RARITY_ORDER } from '/shared/cosmeticMeta.js';
import {
  applyLoadout,
  equipCosmetic,
  equipEmote,
  randomLoadout,
  readCosmetics,
  readEmoteLoadout,
  unequipCosmetic,
  wardrobeCollections,
  wardrobeItems
} from '../core/cosmetics.js';
import {
  markCosmeticsSeen,
  readFavorites,
  readSeenCosmetics,
  toggleFavorite
} from '../core/cosmeticFavorites.js';
import { CosmeticPreview } from '../game/cosmetics/CosmeticPreview.js';

// Шкаф.
//
// Раньше косметика была решёткой кнопок внутри панели аккаунта: четырнадцать предметов помещались,
// шестьдесят четыре — нет. Здесь отдельный экран с превью, вкладками, фильтрами и коллекциями.
//
// Он ничего не знает про конкретные предметы. Всё, что он рисует, приходит из `wardrobeItems()`,
// то есть из каталога: новый предмет появляется в шкафу сам, без правки этого файла. Это и есть
// требование catalog-driven — «не должно требоваться вручную править шесть разных списков».

const $ = selector => document.querySelector(selector);
const OWNERSHIP_FILTERS = ['all', 'owned', 'locked'];

const cssColor = value =>
  `#${Number(value >>> 0)
    .toString(16)
    .padStart(6, '0')
    .slice(-6)}`;

export class Wardrobe {
  constructor({ onChange = () => {}, onEquipError = () => {}, sfx = null } = {}) {
    this.onChange = onChange;
    this.onEquipError = onEquipError;
    this.sfx = sfx;
    this.open = false;
    this.category = 'all';
    this.ownership = 'all';
    this.rarity = 'all';
    this.collection = 'all';
    this.favoritesOnly = false;
    this.selectedId = null;
    this.preview = null;
    this.previewLoadout = null;
    this.progress = null;
    this.profile = null;
    this.lastTime = 0;
    this.frame = 0;
    this.reducedMotion = false;
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    $('#wardrobeClose')?.addEventListener('click', () => this.hide());
    $('#wardrobeEquip')?.addEventListener('click', () => this.equipSelected());
    $('#wardrobeUnequip')?.addEventListener('click', () => this.unequipSelected());
    $('#wardrobeRandom')?.addEventListener('click', () => this.randomize());
    $('#wardrobeResetView')?.addEventListener('click', () => this.preview?.resetRotation());
    $('#wardrobeFavorite')?.addEventListener('click', () => this.toggleSelectedFavorite());
    $('#wardrobeFavoritesFilter')?.addEventListener('click', () => {
      this.favoritesOnly = !this.favoritesOnly;
      this.render();
    });
    $('#wardrobeOwnership')?.addEventListener('change', event => {
      this.ownership = OWNERSHIP_FILTERS.includes(event.target.value) ? event.target.value : 'all';
      this.render();
    });
    $('#wardrobeRarity')?.addEventListener('change', event => {
      this.rarity = event.target.value;
      this.render();
    });
    $('#wardrobeCollection')?.addEventListener('change', event => {
      this.collection = event.target.value;
      this.render();
    });
    this.buildTabs();
    this.buildFilterOptions();
    globalThis.addEventListener?.('resize', () => this.preview?.resize());
  }

  setProgress(progress) {
    this.progress = progress || null;
    if (this.open) this.render();
  }

  setProfile(profile) {
    this.profile = profile || null;
    if (this.open) this.render();
  }

  setReducedMotion(reduced) {
    this.reducedMotion = Boolean(reduced);
    this.preview?.setReducedMotion(this.reducedMotion);
  }

  // ── Каркас ────────────────────────────────────────────────────────────────────────────────

  buildTabs() {
    const tabs = $('#wardrobeTabs');
    if (!tabs) return;
    tabs.replaceChildren();
    const categories = [{ id: 'all', label: 'ВСЁ', icon: '✦' }, ...SLOT_ORDER.map(slot => SLOT_META[slot])];
    for (const category of categories) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wardrobe-tab';
      button.dataset.category = category.id;
      button.setAttribute('role', 'tab');
      button.innerHTML = `<i aria-hidden="true">${category.icon}</i><span>${category.label}</span>`;
      button.addEventListener('click', () => {
        this.category = category.id;
        this.render();
      });
      tabs.append(button);
    }
  }

  buildFilterOptions() {
    const rarity = $('#wardrobeRarity');
    if (rarity) {
      rarity.replaceChildren();
      rarity.append(new Option('ЛЮБАЯ РЕДКОСТЬ', 'all'));
      for (const id of RARITY_ORDER) rarity.append(new Option(RARITY_META[id].label, id));
    }
    const collection = $('#wardrobeCollection');
    if (collection) {
      collection.replaceChildren();
      collection.append(new Option('ВСЕ КОЛЛЕКЦИИ', 'all'));
      collection.append(new Option('БЕЗ КОЛЛЕКЦИИ', 'none'));
      for (const entry of COLLECTIONS) collection.append(new Option(entry.name, entry.id));
    }
  }

  // ── Показ ─────────────────────────────────────────────────────────────────────────────────

  show() {
    this.bind();
    const screen = $('#wardrobe');
    if (!screen) return;
    screen.classList.remove('hidden');
    this.open = true;
    this.previewLoadout = null;
    this.ensurePreview();
    this.render();
    this.startLoop();
  }

  hide() {
    const screen = $('#wardrobe');
    screen?.classList.add('hidden');
    this.open = false;
    this.stopLoop();
    // Превью — отдельный WebGL-контекст. Держать его живым за закрытым экраном значит держать
    // второй контекст на телефоне всё время игры; браузеры такие контексты и сами отбирают.
    this.preview?.dispose();
    this.preview = null;
  }

  ensurePreview() {
    const canvas = $('#wardrobePreview');
    if (!canvas || this.preview) return;
    try {
      this.preview = new CosmeticPreview(canvas, { reducedMotion: this.reducedMotion });
    } catch {
      // Без WebGL шкаф остаётся полностью рабочим: карточки, фильтры и equip от превью не зависят.
      this.preview = null;
      canvas.classList.add('hidden');
    }
  }

  startLoop() {
    this.stopLoop();
    this.lastTime = performance.now();
    const tick = now => {
      if (!this.open) return;
      const dt = Math.min(0.05, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.preview?.update(dt);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stopLoop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  // ── Данные ────────────────────────────────────────────────────────────────────────────────

  entries() {
    return wardrobeItems({
      progress: this.progress,
      profile: this.profile,
      favorites: readFavorites()
    });
  }

  visible(entries) {
    const seen = readSeenCosmetics();
    return entries.filter(entry => {
      if (this.category !== 'all' && entry.slot !== this.category) return false;
      if (this.ownership === 'owned' && !entry.owned) return false;
      if (this.ownership === 'locked' && entry.owned) return false;
      if (this.rarity !== 'all' && entry.item.rarity !== this.rarity) return false;
      if (this.collection === 'none' && entry.collection) return false;
      if (this.collection !== 'all' && this.collection !== 'none' && entry.collection !== this.collection) {
        return false;
      }
      if (this.favoritesOnly && !entry.favorite) return false;
      entry.isNew = entry.owned && !seen.has(entry.id);
      return true;
    });
  }

  render() {
    if (!this.open) return;
    const entries = this.entries();
    const visible = this.visible(entries);

    for (const tab of document.querySelectorAll('.wardrobe-tab')) {
      const active = tab.dataset.category === this.category;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    const favoritesButton = $('#wardrobeFavoritesFilter');
    favoritesButton?.classList.toggle('active', this.favoritesOnly);
    favoritesButton?.setAttribute('aria-pressed', String(this.favoritesOnly));

    if (!this.selectedId || !entries.some(entry => entry.id === this.selectedId)) {
      this.selectedId = visible[0]?.id || entries[0]?.id || null;
    }
    this.renderGrid(visible);
    this.renderDetails(entries.find(entry => entry.id === this.selectedId) || null);
    this.renderCollections();
    this.renderEmoteBar(entries);
    this.applyPreview();
  }

  renderGrid(entries) {
    const grid = $('#wardrobeGrid');
    if (!grid) return;
    grid.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'wardrobe-empty';
      empty.textContent = 'По этим фильтрам ничего нет. Снимите часть фильтров.';
      grid.append(empty);
      return;
    }
    for (const entry of entries) {
      grid.append(this.card(entry));
    }
  }

  card(entry) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'wardrobe-card';
    card.dataset.cosmeticId = entry.id;
    card.dataset.rarity = entry.item.rarity;
    card.dataset.slot = entry.slot;
    card.classList.toggle('is-locked', !entry.owned);
    card.classList.toggle('is-equipped', entry.equipped);
    card.classList.toggle('is-selected', entry.id === this.selectedId);
    card.style.setProperty('--rarity-color', cssColor(entry.rarity.color));
    card.setAttribute(
      'aria-label',
      `${entry.item.name}, ${entry.rarity.label}, ${entry.owned ? 'получено' : 'закрыто'}`
    );

    const swatch = document.createElement('i');
    swatch.className = 'wardrobe-card-swatch';
    // Иконка предмета — его собственные цвета из каталога. Отдельного набора картинок нет
    // намеренно: он был бы шестьдесят первым списком, который надо синхронизировать вручную.
    swatch.style.setProperty(
      '--primary',
      cssColor(entry.item.render.primary ?? entry.item.color ?? 0xff4f91)
    );
    swatch.style.setProperty(
      '--secondary',
      cssColor(entry.item.render.secondary ?? entry.item.render.accent ?? 0xffde59)
    );
    swatch.textContent = entry.owned ? SLOT_META[entry.slot].icon : '🔒';

    const name = document.createElement('strong');
    name.textContent = entry.item.name;

    const meta = document.createElement('small');
    meta.className = 'wardrobe-card-meta';
    // Редкость подписана словом и значком, а не только цветом: цветовое зрение не обязано быть.
    meta.textContent = `${entry.rarity.icon} ${entry.rarity.label}`;

    const state = document.createElement('span');
    state.className = 'wardrobe-card-state';
    state.textContent = entry.equipped ? 'НАДЕТО' : entry.owned ? '' : entry.requirement;

    card.append(swatch, name, meta, state);
    if (entry.collection) {
      const badge = document.createElement('b');
      badge.className = 'wardrobe-card-collection';
      badge.textContent = COLLECTIONS.find(item => item.id === entry.collection)?.shortName || '';
      card.append(badge);
    }
    if (entry.favorite) {
      const star = document.createElement('b');
      star.className = 'wardrobe-card-favorite';
      star.textContent = '★';
      card.append(star);
    }
    if (entry.isNew) {
      const fresh = document.createElement('b');
      fresh.className = 'wardrobe-card-new';
      fresh.textContent = 'NEW';
      card.append(fresh);
    }
    card.addEventListener('click', () => this.select(entry.id));
    return card;
  }

  select(id) {
    this.selectedId = id;
    this.sfx?.uiTick?.();
    this.render();
  }

  renderDetails(entry) {
    const panel = $('#wardrobeDetails');
    if (!panel || !entry) return;
    $('#wardrobeItemName').textContent = entry.item.name;
    $('#wardrobeItemRarity').textContent = `${entry.rarity.icon} ${entry.rarity.label}`;
    $('#wardrobeItemRarity').style.setProperty('--rarity-color', cssColor(entry.rarity.color));
    $('#wardrobeItemSlot').textContent = SLOT_META[entry.slot].label;
    $('#wardrobeItemDescription').textContent = entry.item.description || entry.item.detail || '';

    const collection = COLLECTIONS.find(item => item.id === entry.collection);
    const collectionLine = $('#wardrobeItemCollection');
    collectionLine.textContent = collection ? `${collection.icon} ${collection.name}` : '';
    collectionLine.classList.toggle('hidden', !collection);

    const requirement = $('#wardrobeItemRequirement');
    if (entry.owned) {
      requirement.textContent = 'Получено';
      requirement.classList.remove('locked');
    } else {
      const progress = entry.progress;
      requirement.textContent = progress
        ? `${entry.requirement} · ${Math.min(progress.current, progress.target)}/${progress.target}`
        : entry.requirement;
      requirement.classList.add('locked');
    }

    const equip = $('#wardrobeEquip');
    equip.disabled = !entry.owned || entry.equipped;
    equip.textContent = entry.equipped ? 'НАДЕТО' : entry.owned ? 'НАДЕТЬ' : 'ЗАКРЫТО';
    const unequip = $('#wardrobeUnequip');
    // Тело снять нельзя: персонаж без корпуса — не образ, а невидимка.
    const removable = entry.slot !== 'body' && entry.equipped;
    unequip.classList.toggle('hidden', !removable);

    const favorite = $('#wardrobeFavorite');
    favorite.textContent = entry.favorite ? '★ В ИЗБРАННОМ' : '☆ В ИЗБРАННОЕ';
    favorite.setAttribute('aria-pressed', String(entry.favorite));
  }

  renderCollections() {
    const list = $('#wardrobeCollections');
    if (!list) return;
    list.replaceChildren();
    for (const collection of wardrobeCollections(this.progress, this.profile)) {
      const row = document.createElement('div');
      row.className = 'wardrobe-collection';
      row.dataset.collectionId = collection.id;
      row.classList.toggle('is-complete', collection.complete);
      row.style.setProperty('--collection-color', cssColor(collection.color));

      const title = document.createElement('b');
      title.textContent = `${collection.icon} ${collection.shortName}`;
      const count = document.createElement('span');
      count.textContent = `${collection.owned} / ${collection.total}`;
      const bar = document.createElement('i');
      bar.className = 'wardrobe-collection-bar';
      bar.style.setProperty('--percent', `${collection.percent}%`);
      const percent = document.createElement('small');
      // Значок за сто процентов — только отметка. Никакого игрового бонуса за коллекцию нет и
      // не должно быть: косметика не влияет на шансы победить.
      percent.textContent = collection.complete
        ? `${collection.percent}% ✓ СОБРАНА`
        : `${collection.percent}%`;

      row.append(title, count, bar, percent);
      row.addEventListener('click', () => {
        this.collection = this.collection === collection.id ? 'all' : collection.id;
        const select = $('#wardrobeCollection');
        if (select) select.value = this.collection;
        this.render();
      });
      list.append(row);
    }
  }

  renderEmoteBar(entries) {
    const bar = $('#wardrobeEmotes');
    if (!bar) return;
    bar.classList.toggle('hidden', this.category !== 'all' && this.category !== EMOTE_SLOT);
    bar.replaceChildren();
    const loadout = readEmoteLoadout(this.progress, this.profile);
    const selected = entries.find(entry => entry.id === this.selectedId);
    const canAssign = selected?.slot === EMOTE_SLOT && selected.owned;

    for (let index = 0; index < EMOTE_LOADOUT_SIZE; index++) {
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'wardrobe-emote-slot';
      slot.dataset.position = String(index);
      const item = loadout[index] ? COSMETIC_BY_ID[loadout[index]] : null;
      slot.classList.toggle('is-empty', !item);
      slot.textContent = item ? item.render.glyph || '💃' : String(index + 1);
      slot.title = item ? item.name : 'Пустая ячейка эмоции';
      slot.setAttribute(
        'aria-label',
        item ? `Ячейка ${index + 1}: ${item.name}` : `Ячейка ${index + 1}: пусто`
      );
      slot.addEventListener('click', () => {
        if (canAssign) equipEmote(index, selected.id, this.progress, this.profile);
        else if (item) equipEmote(index, null, this.progress, this.profile);
        this.render();
        this.onChange();
      });
      bar.append(slot);
    }
  }

  // ── Превью ────────────────────────────────────────────────────────────────────────────────

  // Примерка идёт отдельно от надевания: выбранный предмет подставляется в образ на превью, но
  // сохранённый loadout остаётся прежним, пока игрок не нажмёт «Надеть». Именно это и позволяет
  // рассмотреть закрытый предмет, не получая его.
  applyPreview() {
    if (!this.preview) return;
    const equipped = this.previewLoadout || readCosmetics(this.progress, this.profile);
    const loadout = Object.fromEntries(
      Object.entries(equipped).map(([slot, id]) => [slot, COSMETIC_BY_ID[id] || null])
    );
    const selected = this.selectedId ? COSMETIC_BY_ID[this.selectedId] : null;
    if (selected && selected.slot !== EMOTE_SLOT) loadout[selected.slot] = selected;
    this.preview.setLoadout(loadout);
    if (selected?.slot === EMOTE_SLOT) this.preview.playEmote(selected.id);
    if (selected?.slot === 'finish') this.preview.playFinish();
  }

  // ── Действия ──────────────────────────────────────────────────────────────────────────────

  equipSelected() {
    const id = this.selectedId;
    const item = id ? COSMETIC_BY_ID[id] : null;
    if (!item) return;
    if (item.slot === EMOTE_SLOT) {
      const loadout = readEmoteLoadout(this.progress, this.profile);
      const free = loadout.indexOf(null);
      equipEmote(free === -1 ? 0 : free, item.id, this.progress, this.profile);
    } else {
      const before = readCosmetics(this.progress, this.profile)[item.slot];
      const after = equipCosmetic(item.id, this.progress, this.profile)[item.slot];
      if (after !== item.id && before !== item.id) {
        this.onEquipError('Этот предмет ещё закрыт.');
        return;
      }
    }
    this.previewLoadout = null;
    this.sfx?.uiConfirm?.();
    this.render();
    this.onChange();
  }

  unequipSelected() {
    const item = this.selectedId ? COSMETIC_BY_ID[this.selectedId] : null;
    if (!item) return;
    if (item.slot === EMOTE_SLOT) {
      const loadout = readEmoteLoadout(this.progress, this.profile);
      const position = loadout.indexOf(item.id);
      if (position >= 0) equipEmote(position, null, this.progress, this.profile);
    } else unequipCosmetic(item.slot, this.progress, this.profile);
    this.previewLoadout = null;
    this.render();
    this.onChange();
  }

  randomize() {
    const loadout = randomLoadout({ progress: this.progress, profile: this.profile });
    // Сначала показываем, потом сохраняем — но сохраняем сразу же тем же серверным путём, что и
    // обычный equip: отдельной «быстрой» дороги к владению у случайного образа нет.
    this.previewLoadout = loadout;
    applyLoadout(loadout, this.progress, this.profile);
    this.previewLoadout = null;
    this.sfx?.uiConfirm?.();
    this.render();
    this.onChange();
  }

  toggleSelectedFavorite() {
    if (!this.selectedId) return;
    toggleFavorite(this.selectedId);
    this.render();
  }

  /**
   * Карточка «новый предмет». Показывается один раз на предмет: список показанных живёт локально,
   * а владение всё равно остаётся серверным, поэтому подделать здесь нечего.
   */
  announceUnlocks(ownedIds = []) {
    const seen = readSeenCosmetics();
    const fresh = ownedIds.filter(id => COSMETIC_BY_ID[id] && !seen.has(id));
    markCosmeticsSeen(ownedIds);
    if (!fresh.length || !this.knownOwnership) {
      // Первый заход после входа в аккаунт не должен вываливать всю историю наград разом.
      this.knownOwnership = true;
      return null;
    }
    const item = COSMETIC_BY_ID[fresh[0]];
    const card = $('#unlockToast');
    if (!card) return item;
    const meta = rarityMeta(item.rarity);
    const collection = COLLECTIONS.find(entry => entry.id === item.collection);
    card.classList.remove('hidden');
    card.style.setProperty('--rarity-color', cssColor(meta.color));
    $('#unlockName').textContent = item.name;
    $('#unlockMeta').textContent = [`${meta.icon} ${meta.label}`, collection?.shortName]
      .filter(Boolean)
      .join(' · ');
    $('#unlockTry').onclick = () => {
      card.classList.add('hidden');
      this.selectedId = item.id;
      this.show();
    };
    $('#unlockLater').onclick = () => card.classList.add('hidden');
    this.sfx?.unlock?.(item.rarity);
    return item;
  }
}
