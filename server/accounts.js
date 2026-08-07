// Аккаунты игроков и их личные рекорды.
//
// Зачем вообще аккаунт. До него личность игрока была случайными битами в localStorage: она не
// переживала очистку данных браузера и не переносилась на другое устройство. Рекорд, поставленный
// на телефоне, на компьютере не существовал, и объяснить это игроку было нечем.
//
// Вход устроен без пароля: аккаунт заводится сам при первом заходе, а сервер выдаёт код
// восстановления. На своём устройстве вход происходит молча — код лежит в localStorage; на чужом
// его вводят руками. Пароль здесь дал бы ровно ту же защиту, но требовал бы его придумать,
// запомнить и как-то восстанавливать, а почты у нас нет и сбрасывать пароль было бы нечем.

const crypto = require('crypto');

// Код восстановления: четыре группы по четыре знака, WOBBLE-XXXX-XXXX-XXXX-XXXX.
//
// Алфавит без похожих знаков: нет 0/O, 1/I/L, 8/B. Код будут диктовать и переписывать с экрана
// телефона, и пара «ноль или буква О» превращает это в лотерею.
const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXYZ2345679';
const CODE_GROUPS = 4;
const CODE_GROUP_SIZE = 4;
const CODE_PREFIX = 'WOBBLE';

const MAX_NAME = 16;
const MODES = Object.freeze(['solo', 'coop', 'race']);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS personal_records (
    account_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    course_key TEXT NOT NULL,
    time_ms INTEGER NOT NULL,
    achieved_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, mode, course_key)
  );
  CREATE INDEX IF NOT EXISTS idx_records_account ON personal_records (account_id);
`;

class Accounts {
  constructor({ db, maxRecordsPerAccount = 400 } = {}) {
    if (!db) throw new Error('Accounts требует открытую базу');
    this.db = db;
    this.maxRecordsPerAccount = maxRecordsPerAccount;
    this.db.exec(SCHEMA);
    this.statements = prepare(this.db);
  }

  // Новый аккаунт. Код восстановления возвращается ОДИН раз — на сервере хранится только его хеш.
  create(name, now = Date.now()) {
    const secret = generateCode();
    const account = {
      id: crypto.randomUUID(),
      name: safeName(name),
      createdAt: now
    };
    this.statements.insert.run(account.id, account.name, hashCode(secret), now, now);
    return { ...account, secret };
  }

  // Вход по коду. null — код не подошёл; отличать «нет такого» от «неверный» тут нечего, это одно
  // и то же событие.
  login(secret, now = Date.now()) {
    const hash = hashCode(secret);
    if (!hash) return null;
    const row = this.statements.bySecret.get(hash);
    if (!row) return null;
    this.statements.touch.run(now, row.id);
    return { id: row.id, name: row.display_name, createdAt: row.created_at };
  }

  get(id) {
    const row = this.statements.byId.get(String(id || ''));
    return row ? { id: row.id, name: row.display_name, createdAt: row.created_at } : null;
  }

  rename(id, name) {
    const clean = safeName(name);
    this.statements.rename.run(clean, String(id || ''));
    return clean;
  }

  // Личный рекорд. Возвращает { best, improved } — как и локальная запись рекорда на клиенте,
  // чтобы вызывающему не пришлось второй раз выяснять, улучшил игрок время или нет.
  //
  // Хуже прежнего рекорда не пишем: игрок ждёт от «рекорда» лучшего результата, а не последнего.
  saveRecord({ accountId, mode, courseKey, timeMs, achievedAt = Date.now() }) {
    if (!MODES.includes(mode)) return { best: null, improved: false, reason: 'unknown-mode' };
    if (!Number.isFinite(timeMs) || timeMs <= 0) return { best: null, improved: false, reason: 'bad-time' };
    const id = String(accountId || '');
    const key = String(courseKey || '').slice(0, 64);
    if (!id || !key || !this.statements.byId.get(id)) {
      return { best: null, improved: false, reason: 'unknown-account' };
    }

    const time = Math.round(timeMs);
    const previous = this.statements.record.get(id, mode, key);
    if (previous && previous.time_ms <= time) return { best: previous.time_ms, improved: false };

    this.statements.upsertRecord.run(id, mode, key, time, achievedAt);
    // Потолок на аккаунт: трасс бесконечно много (сид случайный), и без него один игрок мог бы
    // растить свою часть базы неограниченно.
    this.statements.trimRecords.run(id, id, this.maxRecordsPerAccount);
    return { best: time, improved: true, first: !previous };
  }

  records(accountId) {
    return this.statements.records.all(String(accountId || '')).map(row => ({
      mode: row.mode,
      courseKey: row.course_key,
      time: row.time_ms,
      achievedAt: row.achieved_at
    }));
  }

  count() {
    return Number(this.statements.count.get().count);
  }
}

// Хеш кода восстановления.
//
// Обычный sha256 без замедления — и это осознанно, а не срезанный угол. Медленные хеши нужны против
// перебора паролей, которые придумал человек: их энтропия мала. Здесь код выдаёт сервер, в нём
// 16 знаков из алфавита в 28 символов, то есть около 2^77 вариантов — перебирать нечего ни быстро,
// ни медленно.
function hashCode(secret) {
  const normalized = normalizeCode(secret);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Приводит введённый код к каноническому виду: регистр, пробелы и дефисы игроку прощаются.
// Человек перепишет код с экрана как получится, и отказывать ему из-за строчной буквы — грубо.
function normalizeCode(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = cleaned.startsWith(CODE_PREFIX) ? cleaned.slice(CODE_PREFIX.length) : cleaned;
  return body.length === CODE_GROUPS * CODE_GROUP_SIZE ? body : '';
}

function generateCode() {
  const groups = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let group = '';
    while (group.length < CODE_GROUP_SIZE) group += CODE_ALPHABET[randomIndex(CODE_ALPHABET.length)];
    groups.push(group);
  }
  return `${CODE_PREFIX}-${groups.join('-')}`;
}

// Равномерный выбор символа. Простое `байт % 28` дало бы небольшой перекос: 256 на 28 не делится,
// и первые четыре символа алфавита выпадали бы чаще остальных. На стойкость кода это почти не
// влияет, но перекос в генераторе случайности — из тех мелочей, которые потом объясняют долго.
function randomIndex(size) {
  const limit = Math.floor(256 / size) * size;
  for (;;) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < limit) return byte % size;
  }
}

// То же правило, что и для имён в комнате: пусто — значит «Wobbler».
function safeName(value) {
  return (
    String(value || 'Wobbler')
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME) || 'Wobbler'
  );
}

function prepare(db) {
  return {
    insert: db.prepare(
      `INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    ),
    bySecret: db.prepare('SELECT id, display_name, created_at FROM accounts WHERE secret_hash = ?'),
    byId: db.prepare('SELECT id, display_name, created_at FROM accounts WHERE id = ?'),
    touch: db.prepare('UPDATE accounts SET last_seen_at = ? WHERE id = ?'),
    rename: db.prepare('UPDATE accounts SET display_name = ? WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS count FROM accounts'),
    record: db.prepare(
      'SELECT time_ms FROM personal_records WHERE account_id = ? AND mode = ? AND course_key = ?'
    ),
    upsertRecord: db.prepare(`
      INSERT INTO personal_records (account_id, mode, course_key, time_ms, achieved_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (account_id, mode, course_key) DO UPDATE SET
        time_ms = excluded.time_ms,
        achieved_at = excluded.achieved_at
    `),
    records: db.prepare(
      `SELECT mode, course_key, time_ms, achieved_at FROM personal_records
       WHERE account_id = ? ORDER BY achieved_at DESC`
    ),
    trimRecords: db.prepare(`
      DELETE FROM personal_records
      WHERE account_id = ? AND rowid NOT IN (
        SELECT rowid FROM personal_records WHERE account_id = ?
        ORDER BY achieved_at DESC LIMIT ?
      )
    `)
  };
}

module.exports = { Accounts, generateCode, normalizeCode, safeName, MODES, MAX_NAME };
