import { COSMETIC_BY_ID } from '/shared/cosmetics.js';
import { readSeenCosmetics } from '../core/cosmeticFavorites.js';

const SAFE_REWARD_STATES = new Set(['menu', 'results']);

export function rewardRevealSafe(stateName) {
  return SAFE_REWARD_STATES.has(stateName);
}

export function freshRewardIds(ownedIds = [], seen = readSeenCosmetics()) {
  return [...new Set(ownedIds)].filter(id => COSMETIC_BY_ID[id] && !seen.has(id));
}

export class RewardRevealQueue {
  constructor({
    windowRef = globalThis,
    getGame = () => globalThis.__WOBBLE_GAME__,
    pollMs = 180
  } = {}) {
    this.window = windowRef;
    this.getGame = getGame;
    this.pollMs = pollMs;
    this.game = null;
    this.original = null;
    this.wrapper = null;
    this.pending = null;
    this.recentIds = new Set();
    this.timer = 0;
    this.active = false;
  }

  init() {
    if (this.active) return this;
    this.active = true;
    this.bindWhenReady();
    return this;
  }

  destroy() {
    this.active = false;
    if (this.timer) this.window?.clearTimeout?.(this.timer);
    this.timer = 0;
    if (this.game?.ui && this.original && this.game.ui.announceUnlocks === this.wrapper) {
      this.game.ui.announceUnlocks = this.original;
    }
    this.game = null;
    this.original = null;
    this.wrapper = null;
    this.pending = null;
  }

  bindWhenReady() {
    if (!this.active) return;
    const game = this.getGame?.();
    if (!game?.ui || typeof game.ui.announceUnlocks !== 'function') {
      this.schedule();
      return;
    }
    this.game = game;
    this.original = game.ui.announceUnlocks.bind(game.ui);
    this.wrapper = ownedIds => this.route(ownedIds);
    game.ui.announceUnlocks = this.wrapper;
  }

  route(ownedIds = []) {
    const snapshot = [...new Set(Array.isArray(ownedIds) ? ownedIds : [])];
    const wardrobeKnown = Boolean(this.game?.ui?.wardrobe?.knownOwnership);
    if (!wardrobeKnown || rewardRevealSafe(this.game?.state?.name)) {
      this.pending = null;
      this.recentIds = new Set(freshRewardIds(snapshot));
      return this.original?.(snapshot) ?? null;
    }
    this.pending = snapshot;
    this.schedule();
    return null;
  }

  flush() {
    if (!this.pending || !rewardRevealSafe(this.game?.state?.name)) return false;
    const snapshot = this.pending;
    this.pending = null;
    this.recentIds = new Set(freshRewardIds(snapshot));
    this.original?.(snapshot);
    return true;
  }

  schedule() {
    if (!this.active || this.timer) return;
    this.timer = this.window?.setTimeout?.(() => {
      this.timer = 0;
      if (!this.game) this.bindWhenReady();
      else this.flush();
      if (this.active && (!this.game || this.pending)) this.schedule();
    }, this.pollMs);
  }
}

export function installRewardRevealQueue(options = {}) {
  const queue = new RewardRevealQueue(options);
  queue.init();
  return queue;
}
