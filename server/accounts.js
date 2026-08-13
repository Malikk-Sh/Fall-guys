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
const { migrateDatabase } = require('./migrations');

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

class Accounts {
  constructor({ db, maxRecordsPerAccount = 400 } = {}) {
    if (!db) throw new Error('Accounts требует открытую базу');
    this.db = db;
    this.maxRecordsPerAccount = maxRecordsPerAccount;
    migrateDatabase(this.db);
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
    this.statements.insertStats.run(account.id, now);
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

  // Прогресс кооперативной кампании записывает только игровой сервер после завершения матча.
  // HTTP-клиент не получает метода, которым мог бы сам объявить главу пройденной.
  recordCoopCompletion({ accountId, chapterId, timeMs, revives = 0, falls = 0, completedAt = Date.now() }) {
    const id = String(accountId || '');
    const chapter = String(chapterId || '');
    if (!this.statements.byId.get(id)) return false;
    if (!/^ch(?:10|[1-9])$/.test(chapter) || !Number.isFinite(timeMs) || timeMs <= 0) return false;
    const time = Math.round(timeMs);
    const saves = Number.isSafeInteger(revives) && revives >= 0 ? revives : 0;
    const downs = Number.isSafeInteger(falls) && falls >= 0 ? falls : 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statements.upsertChapter.run(id, chapter, time, saves, downs === 0 ? 1 : 0, completedAt);
      const uniqueChapters = Number(this.statements.chapterCount.get(id).count);
      this.statements.updateStats.run(uniqueChapters, saves, completedAt, id);
      this.statements.unlockAchievement.run(id, 'coop-first-clear', completedAt);
      if (downs === 0) this.statements.unlockAchievement.run(id, 'coop-flawless', completedAt);
      if (chapter === 'ch10') this.statements.unlockAchievement.run(id, 'coop-ch10-clear', completedAt);
      if (uniqueChapters === 10)
        this.statements.unlockAchievement.run(id, 'coop-campaign-complete', completedAt);
      const stats = this.statements.stats.get(id);
      const flawless = Number(this.statements.flawlessCount.get(id)?.count || 0);
      if (flawless >= 5) this.statements.unlockAchievement.run(id, 'coop-flawless-5', completedAt);
      if (Number(stats?.coop_revives || 0) >= 25)
        this.statements.unlockAchievement.run(id, 'coop-helper-25', completedAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  // Итог онлайн-гонки. Как и кооперативный прогресс, пишется только игровым сервером после матча:
  // HTTP-клиенту метода объявить себя победителем не выдано.
  //
  // `finishers` — сколько человек ДОШЛО до ленты, а не сколько стартовало. Место среди дошедших —
  // единственное честное основание для награды: тройка в гонке, где финишировали трое, и тройка
  // среди шестнадцати — разные вещи, и первая пьедесталом не считается.
  recordRaceFinish({ accountId, place, finishers, finishedAt = Date.now() }) {
    const id = String(accountId || '');
    if (!this.statements.byId.get(id)) return false;
    if (!Number.isSafeInteger(place) || place < 1) return false;
    if (!Number.isSafeInteger(finishers) || finishers < 1 || place > finishers) return false;

    // Победа засчитывается только при живом сопернике, дошедшем до конца. Иначе «первое место»
    // получал бы любой, кто добежал один, — и достижение означало бы «доиграл», а не «выиграл».
    const won = place === 1 && finishers >= 2;
    // Пьедестал требует, чтобы под ним было кого обойти.
    const podium = place <= 3 && finishers >= 3;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statements.upsertRaceStats.run(id, podium ? 1 : 0, won ? 1 : 0, place, finishedAt);
      const stats = this.statements.raceStats.get(id);
      this.statements.unlockAchievement.run(id, 'race-first-finish', finishedAt);
      if (podium) this.statements.unlockAchievement.run(id, 'race-podium', finishedAt);
      if (won) this.statements.unlockAchievement.run(id, 'race-win', finishedAt);
      if (Number(stats?.finishes || 0) >= 25) {
        this.statements.unlockAchievement.run(id, 'race-veteran-25', finishedAt);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  raceStats(accountId) {
    const row = this.statements.raceStats.get(String(accountId || ''));
    return {
      finishes: Number(row?.finishes || 0),
      podiums: Number(row?.podiums || 0),
      wins: Number(row?.wins || 0),
      bestPlace: row?.best_place == null ? null : Number(row.best_place)
    };
  }

  progress(accountId) {
    const id = String(accountId || '');
    const stats = this.statements.stats.get(id);
    return {
      stats: {
        coopMatchesCompleted: Number(stats?.coop_matches_completed || 0),
        coopChaptersCompleted: Number(stats?.coop_chapters_completed || 0),
        coopRevives: Number(stats?.coop_revives || 0)
      },
      chapters: this.statements.chapters.all(id).map(row => ({
        chapterId: row.chapter_id,
        completions: row.completions,
        bestTime: row.best_time_ms,
        revives: row.revives,
        flawless: row.flawless,
        lastCompletedAt: row.last_completed_at
      })),
      achievements: this.statements.achievements.all(id).map(row => ({
        id: row.achievement_id,
        unlockedAt: row.unlocked_at
      }))
    };
  }

  // Последний напарник записывается только после завершённого сервером кооперативного матча.
  // Клиент не присылает partner id, поэтому сам подделать эту историю не может.
  recordCoopPartners({ accountIds, chapterId, playedAt = Date.now() }) {
    const chapter = String(chapterId || '');
    if (!/^ch(?:10|[1-9])$/.test(chapter)) return 0;
    const ids = [
      ...new Set(
        (Array.isArray(accountIds) ? accountIds : [])
          .map(id => String(id || ''))
          .filter(id => id && this.statements.byId.get(id))
      )
    ];
    if (ids.length < 2) return 0;
    const at = Number.isFinite(playedAt) && playedAt >= 0 ? Math.round(playedAt) : Date.now();
    let writes = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const accountId of ids) {
        for (const partnerId of ids) {
          if (accountId === partnerId) continue;
          this.statements.upsertRecentPartner.run(accountId, partnerId, chapter, at);
          writes++;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return writes;
  }

  profile(accountId) {
    const id = String(accountId || '');
    if (!this.statements.byId.get(id)) return null;
    const progress = this.progress(id);
    const campaignAchievement = progress.achievements.find(item => item.id === 'coop-campaign-complete');
    const recent = this.statements.recentPartner.get(id);
    return {
      stats: {
        ...progress.stats,
        coopFlawless: Number(this.statements.flawlessCount.get(id)?.count || 0)
      },
      achievements: progress.achievements,
      campaign: {
        completed: Boolean(campaignAchievement),
        completedAt: campaignAchievement?.unlockedAt || null,
        chaptersCompleted: progress.stats.coopChaptersCompleted,
        totalChapters: 10
      },
      recentPartner: recent
        ? {
            id: recent.partner_account_id,
            name: recent.display_name,
            matchesTogether: Number(recent.matches_together || 0),
            lastChapterId: recent.last_chapter_id,
            lastPlayedAt: recent.last_played_at,
            avoided: Boolean(recent.avoided)
          }
        : null
    };
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
    insertStats: db.prepare(`INSERT OR IGNORE INTO account_stats (account_id, updated_at) VALUES (?, ?)`),
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
    `),
    upsertChapter: db.prepare(`
      INSERT INTO chapter_progress
        (account_id, chapter_id, completions, best_time_ms, revives, flawless, last_completed_at)
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT (account_id, chapter_id) DO UPDATE SET
        completions = completions + 1,
        best_time_ms = MIN(best_time_ms, excluded.best_time_ms),
        revives = revives + excluded.revives,
        flawless = flawless + excluded.flawless,
        last_completed_at = excluded.last_completed_at
    `),
    chapterCount: db.prepare('SELECT COUNT(*) AS count FROM chapter_progress WHERE account_id = ?'),
    flawlessCount: db.prepare(
      'SELECT COALESCE(SUM(flawless), 0) AS count FROM chapter_progress WHERE account_id = ?'
    ),
    updateStats: db.prepare(`
      UPDATE account_stats SET
        coop_matches_completed = coop_matches_completed + 1,
        coop_chapters_completed = ?,
        coop_revives = coop_revives + ?,
        updated_at = ?
      WHERE account_id = ?
    `),
    stats: db.prepare('SELECT * FROM account_stats WHERE account_id = ?'),
    chapters: db.prepare('SELECT * FROM chapter_progress WHERE account_id = ? ORDER BY chapter_id'),
    unlockAchievement: db.prepare(`
      INSERT OR IGNORE INTO achievements (account_id, achievement_id, unlocked_at) VALUES (?, ?, ?)
    `),
    // Одна строка на аккаунт, заводится первым же финишем. best_place берётся минимумом: MIN с
    // NULL в SQLite возвращает не-NULL аргумент, поэтому первый финиш кладётся как есть.
    upsertRaceStats: db.prepare(`
      INSERT INTO account_race_stats (account_id, finishes, podiums, wins, best_place, updated_at)
      VALUES (?1, 1, ?2, ?3, ?4, ?5)
      ON CONFLICT(account_id) DO UPDATE SET
        finishes = finishes + 1,
        podiums = podiums + ?2,
        wins = wins + ?3,
        best_place = MIN(COALESCE(best_place, ?4), ?4),
        updated_at = ?5
    `),
    raceStats: db.prepare(
      'SELECT finishes, podiums, wins, best_place FROM account_race_stats WHERE account_id = ?'
    ),
    achievements: db.prepare(
      'SELECT achievement_id, unlocked_at FROM achievements WHERE account_id = ? ORDER BY unlocked_at'
    ),
    upsertRecentPartner: db.prepare(`
      INSERT INTO recent_partners
        (account_id, partner_account_id, matches_together, last_chapter_id, last_played_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT (account_id, partner_account_id) DO UPDATE SET
        matches_together = matches_together + 1,
        last_chapter_id = excluded.last_chapter_id,
        last_played_at = excluded.last_played_at
    `),
    recentPartner: db.prepare(`
      SELECT rp.partner_account_id, a.display_name, rp.matches_together,
             rp.last_chapter_id, rp.last_played_at,
   EXISTS (
     SELECT 1 FROM matchmaking_avoids ma
     WHERE (
       ma.account_a = rp.account_id
       AND ma.account_b = rp.partner_account_id
       AND ma.account_a_avoided_at IS NOT NULL
     ) OR (
       ma.account_b = rp.account_id
       AND ma.account_a = rp.partner_account_id
       AND ma.account_b_avoided_at IS NOT NULL
     )
   ) AS avoided
      FROM recent_partners rp
      JOIN accounts a ON a.id = rp.partner_account_id
      WHERE rp.account_id = ?
      ORDER BY rp.last_played_at DESC, rp.partner_account_id ASC
      LIMIT 1
    `)
  };
}

module.exports = { Accounts, generateCode, normalizeCode, safeName, MODES, MAX_NAME };
