const { migrateDatabase } = require('./migrations');
const { COSMETIC_CATALOG } = require('../shared/cosmetics.js');

const REWARDED_DAILY_LIMIT = 3;
const REWARDABLE_COSMETICS = Object.freeze(
  COSMETIC_CATALOG.filter(item => item.rewardable).map(item => item.id)
);

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

class RewardService {
  constructor({ db, inventory, dailyLimit = REWARDED_DAILY_LIMIT } = {}) {
    if (!db || !inventory) throw new Error('RewardService требует db и inventory');
    this.db = db;
    this.inventory = inventory;
    this.dailyLimit = dailyLimit;
    migrateDatabase(db);
    this.statements = prepare(db);
  }

  grant({ accountId, source, reward = 'random_cosmetic', idempotencyKey, now = Date.now() }) {
    const id = String(accountId || '');
    const safeSource = String(source || '');
    const key = String(idempotencyKey || '').trim();
    if (!id || !key || key.length > 160) return { ok: false, reason: 'invalid-request' };
    if (!['rewarded_ad', 'dev_rewarded'].includes(safeSource)) {
      return { ok: false, reason: 'unsupported-source' };
    }

    const existing = this.statements.byKey.get(key);
    if (existing) {
      if (existing.account_id !== id) return { ok: false, reason: 'idempotency-conflict' };
      return {
        ok: true,
        duplicate: true,
        cosmeticId: existing.cosmetic_id,
        reward: existing.reward,
        inventory: this.inventory.profile(id)
      };
    }

    const today = dayKey(now);
    const used = this.statements.countDay.get(id, today).count;
    if (used >= this.dailyLimit) return { ok: false, reason: 'daily-limit' };
    if (reward !== 'random_cosmetic') return { ok: false, reason: 'unknown-reward' };

    this.inventory.syncEntitlements(id, now);
    const owned = new Set(this.inventory.owned(id).map(item => item.id));
    const available = REWARDABLE_COSMETICS.filter(cosmeticId => !owned.has(cosmeticId));
    if (!available.length) {
      return {
        ok: false,
        reason: 'pool-exhausted',
        inventory: this.inventory.profile(id)
      };
    }
    const cosmeticId = available[used % available.length];

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statements.insert.run(key, id, safeSource, reward, cosmeticId, now, today);
      const granted = this.inventory.grant(id, cosmeticId, `reward:${safeSource}`, now);
      if (!granted) throw new Error('Reward cosmetic was not granted');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      const raced = this.statements.byKey.get(key);
      if (raced?.account_id === id) {
        return {
          ok: true,
          duplicate: true,
          cosmeticId: raced.cosmetic_id,
          reward: raced.reward,
          inventory: this.inventory.profile(id)
        };
      }
      throw error;
    }

    return {
      ok: true,
      duplicate: false,
      cosmeticId,
      reward,
      remainingToday: Math.max(0, this.dailyLimit - used - 1),
      inventory: this.inventory.profile(id)
    };
  }
}

function prepare(db) {
  return {
    byKey: db.prepare(`
      SELECT account_id, reward, cosmetic_id
      FROM reward_grants
      WHERE idempotency_key = ?
    `),
    countDay: db.prepare(`
      SELECT COUNT(*) AS count
      FROM reward_grants
      WHERE account_id = ? AND day_key = ?
    `),
    insert: db.prepare(`
      INSERT INTO reward_grants
        (idempotency_key, account_id, source, reward, cosmetic_id, granted_at, day_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
  };
}

module.exports = { RewardService, REWARDED_DAILY_LIMIT, REWARDABLE_COSMETICS, dayKey };
