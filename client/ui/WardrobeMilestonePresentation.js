import { wardrobeCollections } from '../core/cosmetics.js';
import { readSeenCosmetics } from '../core/cosmeticFavorites.js';

const STYLESHEET_ID = 'rewardUxStylesheet';

export function milestonePresentationState(reward, seen = new Set(), recent = new Set()) {
  if (!reward?.owned) return 'locked';
  if (recent.has(reward.id) || !seen.has(reward.id)) return 'new';
  return 'reached';
}

function installStylesheet(root) {
  if (!root?.head || root.getElementById(STYLESHEET_ID)) return;
  const link = root.createElement('link');
  link.id = STYLESHEET_ID;
  link.rel = 'stylesheet';
  link.href = '/reward-ux.css';
  root.head.append(link);
}

export class WardrobeMilestonePresentation {
  constructor({
    root = globalThis.document,
    windowRef = globalThis,
    getWardrobe = () => globalThis.__WOBBLE_GAME__?.ui?.wardrobe,
    getRecentIds = () => globalThis.__WOBBLE_REWARD_REVEAL__?.recentIds || new Set()
  } = {}) {
    this.root = root;
    this.window = windowRef;
    this.getWardrobe = getWardrobe;
    this.getRecentIds = getRecentIds;
    this.observer = null;
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
    this.observer?.disconnect?.();
    this.observer = null;
  }

  sync() {
    const host = this.root?.getElementById?.('wardrobeCollections');
    const wardrobe = this.getWardrobe?.();
    if (!host || !wardrobe) return;
    const seen = readSeenCosmetics();
    const recent = this.getRecentIds?.() || new Set();
    const collections = new Map(
      wardrobeCollections(wardrobe.progress, wardrobe.profile).map(collection => [collection.id, collection])
    );

    for (const row of host.querySelectorAll('.wardrobe-collection')) {
      const collection = collections.get(row.dataset.collectionId);
      if (!collection) continue;
      const chips = [...row.querySelectorAll('.wardrobe-chip')];
      const track = chips[0]?.parentElement;
      track?.classList.add('wardrobe-milestone-track');
      chips.forEach((chip, index) => {
        const reward = collection.milestones?.[index];
        if (!reward) return;
        const state = milestonePresentationState(reward, seen, recent);
        chip.classList.add('wardrobe-milestone-node');
        chip.dataset.milestoneState = state;
        chip.dataset.milestoneId = reward.id;
        chip.dataset.threshold = String(reward.threshold);
      });
    }
  }
}

export function installWardrobeMilestonePresentation(options = {}) {
  const presentation = new WardrobeMilestonePresentation(options);
  presentation.init();
  return presentation;
}
