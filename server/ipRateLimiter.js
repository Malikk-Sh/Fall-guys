'use strict';

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

class BoundedIpRateLimiter {
  constructor({
    windowMs = DEFAULT_WINDOW_MS,
    cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES
  } = {}) {
    this.windowMs = positive(windowMs, DEFAULT_WINDOW_MS);
    this.cleanupIntervalMs = positive(cleanupIntervalMs, DEFAULT_CLEANUP_INTERVAL_MS);
    this.maxEntries = positive(maxEntries, DEFAULT_MAX_ENTRIES);
    this.entries = new Map();
    this.nextCleanupAt = 0;
  }

  limited(ip, maxAttempts, now = Date.now()) {
    if (!ip) return false;
    const max = positive(maxAttempts, 1);
    this.cleanup(now);

    const key = String(ip);
    const current = this.entries.get(key);
    if (!current || current.expiresAt <= now) {
      if (current) this.entries.delete(key);
      this.makeRoom();
      this.entries.set(key, { count: 1, expiresAt: now + this.windowMs });
      return false;
    }

    current.count += 1;
    return current.count > max;
  }

  cleanup(now = Date.now(), { force = false } = {}) {
    if (!force && now < this.nextCleanupAt && this.entries.size < this.maxEntries) return 0;

    let removed = 0;
    for (const [ip, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.entries.delete(ip);
      removed += 1;
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      removed += 1;
    }
    this.nextCleanupAt = now + this.cleanupIntervalMs;
    return removed;
  }

  makeRoom() {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear() {
    this.entries.clear();
    this.nextCleanupAt = 0;
  }

  get size() {
    return this.entries.size;
  }
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

module.exports = {
  BoundedIpRateLimiter,
  DEFAULT_WINDOW_MS,
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_MAX_ENTRIES
};
