const { migrateDatabase } = require('./migrations');
const {
  COSMETIC_CATALOG,
  COSMETIC_BY_ID,
  COSMETIC_SLOTS,
  DEFAULT_COSMETIC_LOADOUT,
  EMOTE_LOADOUT_SIZE,
  EMOTE_SLOT,
  publicCosmeticLoadout,
  publicEmoteLoadout,
  collectionProgress
} = require('../shared/cosmetics.js');
const { resolveServerGrants, statsFromProgress } = require('../shared/cosmeticUnlocks.js');

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

  // Выдача по каталогу, а не по списку веток.
  //
  // Раньше здесь перебирались предметы с полем `achievement`; с появлением stat-условий такой
  // перебор пришлось бы дописывать при каждом новом типе. Теперь условие читает общий резолвер, и
  // сервер выдаёт ровно то, что каталог объявил серверно выдаваемым: rewarded/shop/pass/event
  // сюда не попадают никогда — entitlement по клиентскому «успеху» не выдаётся.
  syncEntitlements(accountId, now = Date.now()) {
    const id = String(accountId || '');
    if (!this.statements.account.get(id)) return null;
    this.ensureLoadout(id, now);

    const progress = this.accounts.progress(id);
    const achievements = new Set((progress?.achievements || []).map(item => item.id));
    const stats = statsFromProgress(progress);
    for (const cosmeticId of resolveServerGrants(COSMETIC_CATALOG, { stats, achievements })) {
      this.grant(id, cosmeticId, grantSource(COSMETIC_BY_ID[cosmeticId]), now);
    }

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

  // Порядок ячеек задаёт клиент, но валидность — сервер: чужой слот, неизвестный ID и повтор
  // отсекаются нормализацией, а не доверием к сохранённой строке.
  emoteLoadout(accountId) {
    const rows = this.statements.emotes.all(String(accountId || ''));
    const slots = new Array(EMOTE_LOADOUT_SIZE).fill(null);
    for (const row of rows) {
      const position = Number(row.position);
      if (Number.isInteger(position) && position >= 0 && position < EMOTE_LOADOUT_SIZE) {
        slots[position] = row.cosmetic_id;
      }
    }
    return publicEmoteLoadout(slots);
  }

  owns(accountId, cosmeticId) {
    if (cosmeticId == null) return true;
    return Boolean(this.statements.owns.get(String(accountId || ''), String(cosmeticId || '')));
  }

  equip(accountId, slot, cosmeticId, now = Date.now()) {
    const id = String(accountId || '');
    const safeSlot = String(slot || '');
    const safeCosmetic = cosmeticId == null || cosmeticId === '' ? null : String(cosmeticId);
    if (!COSMETIC_SLOTS.includes(safeSlot)) return { ok: false, reason: 'unknown-slot' };
    if (safeSlot === 'body' && !safeCosmetic) return { ok: false, reason: 'body-required' };
    if (safeCosmetic) {
      const cosmetic = COSMETIC_BY_ID[safeCosmetic];
      if (!cosmetic || cosmetic.slot !== safeSlot) return { ok: false, reason: 'wrong-slot' };
      if (!this.owns(id, safeCosmetic)) return { ok: false, reason: 'not-owned' };
    }
    if (!this.ensureLoadout(id, now)) return { ok: false, reason: 'unknown-account' };
    this.statements[`equip_${safeSlot}`].run(safeCosmetic, now, id);
    return { ok: true, loadout: this.loadout(id) };
  }

  /**
   * Эмоция в ячейку 0..3. Пустой ID очищает ячейку.
   *
   * Проверки те же, что у носимых слотов, плюс запрет дубликата: одна и та же эмоция в двух
   * ячейках — не польза, а потерянная ячейка.
   */
  equipEmote(accountId, position, cosmeticId, now = Date.now()) {
    const id = String(accountId || '');
    const index = Number(position);
    const safeCosmetic = cosmeticId == null || cosmeticId === '' ? null : String(cosmeticId);
    if (!Number.isInteger(index) || index < 0 || index >= EMOTE_LOADOUT_SIZE) {
      return { ok: false, reason: 'unknown-slot' };
    }
    if (safeCosmetic) {
      const cosmetic = COSMETIC_BY_ID[safeCosmetic];
      if (!cosmetic || cosmetic.slot !== EMOTE_SLOT) return { ok: false, reason: 'wrong-slot' };
      if (!this.owns(id, safeCosmetic)) return { ok: false, reason: 'not-owned' };
    }
    if (!this.ensureLoadout(id, now)) return { ok: false, reason: 'unknown-account' };
    if (safeCosmetic) this.statements.clearEmoteById.run(id, safeCosmetic);
    this.statements.setEmote.run(id, index, safeCosmetic, now);
    return { ok: true, emotes: this.emoteLoadout(id) };
  }

  /**
   * Разрешено ли игроку проиграть эту эмоцию прямо сейчас: предмет существует, принадлежит ему и
   * выбран в его loadout. Проверяется на каждый сетевой emote — выбранный набор может измениться
   * между двумя сообщениями.
   */
  canPlayEmote(accountId, cosmeticId) {
    const id = String(accountId || '');
    const cosmetic = COSMETIC_BY_ID[cosmeticId];
    if (!cosmetic || cosmetic.slot !== EMOTE_SLOT) return false;
    if (!this.owns(id, cosmetic.id)) return false;
    return this.emoteLoadout(id).includes(cosmetic.id);
  }

  publicLoadout(accountId) {
    this.syncEntitlements(accountId);
    return this.loadout(accountId);
  }

  profile(accountId) {
    const id = String(accountId || '');
    if (!this.ensureLoadout(id)) return null;
    const owned = this.owned(id);
    const ownedIds = owned.map(item => item.id);
    return {
      owned,
      ownedIds,
      equipped: this.loadout(id),
      emotes: this.emoteLoadout(id),
      collections: collectionProgress(ownedIds),
      total: COSMETIC_CATALOG.length
    };
  }
}

// Источник записывается в ledger и виден в поддержке: «откуда у игрока этот предмет» — первый
// вопрос при разборе жалобы, и отвечать на него «system» для всего каталога бесполезно.
function grantSource(cosmetic) {
  const unlock = cosmetic?.unlock;
  if (!unlock) return 'system';
  if (unlock.type === 'default') return 'default';
  if (unlock.type === 'achievement') return `achievement:${unlock.id}`;
  if (unlock.type === 'stat') return `stat:${unlock.path}>=${unlock.gte}`;
  return unlock.type;
}

function prepare(db) {
  const columns = COSMETIC_SLOTS.join(', ');
  const placeholders = COSMETIC_SLOTS.map(slot => (slot === 'body' ? "'classic'" : 'NULL')).join(', ');
  const statements = {
    account: db.prepare('SELECT id FROM accounts WHERE id = ?'),
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
      INSERT OR IGNORE INTO account_loadout
        (account_id, ${columns}, updated_at)
      VALUES (?, ${placeholders}, ?)
    `),
    loadout: db.prepare(`SELECT ${columns} FROM account_loadout WHERE account_id = ?`),
    emotes: db.prepare(`
      SELECT position, cosmetic_id
      FROM account_emote_loadout
      WHERE account_id = ?
      ORDER BY position
    `),
    setEmote: db.prepare(`
      INSERT INTO account_emote_loadout (account_id, position, cosmetic_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (account_id, position)
      DO UPDATE SET cosmetic_id = excluded.cosmetic_id, updated_at = excluded.updated_at
    `),
    clearEmoteById: db.prepare(`
      UPDATE account_emote_loadout SET cosmetic_id = NULL
      WHERE account_id = ? AND cosmetic_id = ?
    `)
  };
  for (const slot of COSMETIC_SLOTS) {
    statements[`equip_${slot}`] = db.prepare(
      `UPDATE account_loadout SET ${slot} = ?, updated_at = ? WHERE account_id = ?`
    );
  }
  return statements;
}

module.exports = { InventoryService };
