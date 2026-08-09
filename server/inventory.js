const { migrateDatabase } = require('./migrations');
const {
  COSMETIC_CATALOG,
  COSMETIC_BY_ID,
  COSMETIC_SLOTS,
  DEFAULT_COSMETIC_LOADOUT,
  publicCosmeticLoadout
} = require('../shared/cosmetics.js');

class InventoryService {
  constructor({ db, accounts } = {}) {
    if (!db || !accounts) throw new Error('InventoryService требует db и accounts');
    this.db = db;
    this.accounts = accounts;
    migrateDatabase(db);
    this.statements = prepare(db);
  }

  ensureLoadout(accountId, now = Date.now()) {
    const id = String(accountId || '');
    if (!this.statements.account.get(id)) return null;
    this.statements.insertLoadout.run(id, now);
    return this.loadout(id);
  }

  grant(accountId, cosmeticId, source = 'system', now = Date.now()) {
    const id = String(accountId || '');
    const cosmetic = COSMETIC_BY_ID[cosmeticId];
    if (!cosmetic || !this.statements.account.get(id)) return false;
    return this.statements.insertCosmetic.run(id, cosmetic.id, now, String(source || 'system')).changes > 0;
  }

  syncEntitlements(accountId, now = Date.now()) {
    const id = String(accountId || '');
    if (!this.statements.account.get(id)) return null;
    this.ensureLoadout(id, now);
    this.grant(id, 'body-mint', 'default', now);

    const progress = this.accounts.progress(id);
    const achievements = new Set((progress?.achievements || []).map(item => item.id));
    const stats = this.statements.stats.get(id) || {};

    if (achievements.has('campaign_complete')) {
      this.grant(id, 'body-sunset', 'achievement', now);
      this.grant(id, 'finish-champion', 'campaign', now);
    }
    if ((stats.flawless_completions || 0) >= 3) this.grant(id, 'head-crown', 'achievement', now);
    if ((stats.coop_matches_completed || 0) >= 12) this.grant(id, 'trail-spark', 'achievement', now);
    if ((stats.best_streak || 0) >= 3) this.grant(id, 'finish-stars', 'achievement', now);

    return this.profile(id);
  }

  owned(accountId) {
    return this.statements.owned.all(String(accountId || '')).map(row => ({
      id: row.cosmetic_id,
      slot: COSMETIC_BY_ID[row.cosmetic_id]?.slot || null,
      unlockedAt: row.unlocked_at,
      source: row.source
    }));
  }

  loadout(accountId) {
    const row = this.statements.loadout.get(String(accountId || ''));
    return publicCosmeticLoadout(row || DEFAULT_COSMETIC_LOADOUT);
  }

  owns(accountId, cosmeticId) {
    if (cosmeticId === 'none') return true;
    return Boolean(this.statements.owns.get(String(accountId || ''), String(cosmeticId || '')));
  }

  equip(accountId, slot, cosmeticId, now = Date.now()) {
    const id = String(accountId || '');
    const safeSlot = String(slot || '');
    const safeCosmetic = String(cosmeticId || '');
    if (!COSMETIC_SLOTS.includes(safeSlot)) return { ok: false, reason: 'unknown-slot' };
    if (safeSlot === 'body' && safeCosmetic === 'none') return { ok: false, reason: 'body-required' };
    if (safeCosmetic !== 'none') {
      const cosmetic = COSMETIC_BY_ID[safeCosmetic];
      if (!cosmetic || cosmetic.slot !== safeSlot) return { ok: false, reason: 'wrong-slot' };
      if (!this.owns(id, safeCosmetic)) return { ok: false, reason: 'not-owned' };
    }
    if (!this.ensureLoadout(id, now)) return { ok: false, reason: 'unknown-account' };
    this.statements[`equip_${safeSlot}`].run(safeCosmetic, now, id);
    return { ok: true, loadout: this.loadout(id) };
  }

  publicLoadout(accountId) {
    this.syncEntitlements(accountId);
    return this.loadout(accountId);
  }

  profile(accountId) {
    const id = String(accountId || '');
    this.ensureLoadout(id);
    const owned = this.owned(id);
    return {
      owned,
      ownedIds: owned.map(item => item.id),
      equipped: this.loadout(id),
      total: COSMETIC_CATALOG.length
    };
  }
}

function prepare(db) {
  const statements = {
    account: db.prepare('SELECT id FROM accounts WHERE id = ?'),
    stats: db.prepare(`
      SELECT flawless_completions, coop_matches_completed, best_streak
      FROM account_stats
      WHERE account_id = ?
    `),
    insertCosmetic: db.prepare(`
      INSERT OR IGNORE INTO account_cosmetics (account_id, cosmetic_id, unlocked_at, source)
      VALUES (?, ?, ?, ?)
    `),
    owned: db.prepare(`
      SELECT cosmetic_id, unlocked_at, source
      FROM account_cosmetics
      WHERE account_id = ?
      ORDER BY unlocked_at, cosmetic_id
    `),
    owns: db.prepare('SELECT 1 FROM account_cosmetics WHERE account_id = ? AND cosmetic_id = ?'),
    insertLoadout: db.prepare(`
      INSERT OR IGNORE INTO account_loadout (account_id, body, head, trail, finish, updated_at)
      VALUES (?, 'body-mint', 'none', 'none', 'none', ?)
    `),
    loadout: db.prepare('SELECT body, head, trail, finish FROM account_loadout WHERE account_id = ?')
  };
  for (const slot of COSMETIC_SLOTS) {
    statements[`equip_${slot}`] = db.prepare(
      `UPDATE account_loadout SET ${slot} = ?, updated_at = ? WHERE account_id = ?`
    );
  }
  return statements;
}

module.exports = { InventoryService };
