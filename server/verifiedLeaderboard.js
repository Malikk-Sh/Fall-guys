// Таблица подтверждённых рекордов. Хранится в SQLite, а не в памяти процесса.
//
// Раньше здесь были обычные Map и Set. Это работало ровно до первого перезапуска: после обновления
// сервера, рестарта VPS или падения процесса все рекорды исчезали. Интерфейс при этом продолжал
// обещать «подтверждённый рекорд» — то есть показывал игроку достижение, которое существовало
// только до следующего деплоя.
//
// Взят встроенный node:sqlite: он есть в Node 22.5+ и не требует ни компиляции нативного модуля на
// сервере, ни новой зависимости в package.json. Для одного процесса на одном VPS этого достаточно;
// PostgreSQL или Redis понадобятся, только когда экземпляров станет несколько.

const { openDatabase } = require('./db');

// Версия алгоритма проверки забега. Хранится вместе с рекордом.
//
// Проверка честности времени будет ужесточаться, и без версии старые записи неотличимы от новых:
// рекорд, принятый прошлой, более мягкой проверкой, выглядел бы как проверенный нынешней. Номер
// поднимается при любом изменении правил в verifyMovement/verifyCheckpointTime, после которого
// прежние результаты уже не считаются подтверждёнными по текущим меркам.
const VERIFICATION_VERSION = 1;

// Сколько записей хранить на трассу и сколько отдавать по умолчанию.
//
// Хранится заметно больше, чем показывается: место игрока и отставание от соседа сверху нужно уметь
// посчитать и тем, кто в десятку не попал.
const STORED_PER_COURSE = 100;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_COURSES = 512;
const MAX_RECORDED_MATCHES = 20_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS leaderboard_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_seed INTEGER NOT NULL,
    difficulty TEXT NOT NULL,
    player_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    color INTEGER NOT NULL,
    time_ms INTEGER NOT NULL,
    achieved_at INTEGER NOT NULL,
    verification_version INTEGER NOT NULL,
    match_id TEXT NOT NULL,
    UNIQUE (course_seed, difficulty, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_entries_course
    ON leaderboard_entries (course_seed, difficulty, time_ms, achieved_at);
  CREATE TABLE IF NOT EXISTS recorded_matches (
    match_id TEXT PRIMARY KEY,
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_matches_time ON recorded_matches (recorded_at);
`;

class VerifiedLeaderboard {
  // `file` по умолчанию ':memory:' — так тесты гоняют ровно тот же SQL, что и боевой сервер, но без
  // файла на диске. Отдельной реализации «в памяти» нет намеренно: две ветки кода разошлись бы, и
  // проверенным оказался бы не тот путь, который работает у игроков.
  // `db` передаётся, когда соединение общее с аккаунтами: таблицы живут в одном файле, и открывать
  // его вторым соединением значило бы получать редкие «database is locked» на ровном месте.
  // Без него открывается своё — так работают тесты, где нужна только эта таблица.
  constructor({
    file = ':memory:',
    db = null,
    limit = DEFAULT_LIMIT,
    storedPerCourse = STORED_PER_COURSE,
    maxCourses = MAX_COURSES,
    verificationVersion = VERIFICATION_VERSION
  } = {}) {
    this.limit = limit;
    this.storedPerCourse = storedPerCourse;
    this.maxCourses = maxCourses;
    this.verificationVersion = verificationVersion;
    this.ownsDb = !db;
    this.db = db || openDatabase(file);
    this.db.exec(SCHEMA);
    this.statements = prepare(this.db);
  }

  // Возвращает true, если матч учтён впервые. Записи внутри матча складываются по лучшему времени
  // каждого игрока: один человек занимает в таблице ровно одну строку на трассу.
  record({ matchId, seed, difficulty, entries, achievedAt = Date.now() }) {
    if (!matchId || !Number.isSafeInteger(seed) || !Array.isArray(entries)) return false;
    const verified = entries.filter(
      entry => entry?.verified && Number.isFinite(entry.time) && entry.time > 0
    );
    if (!verified.length) return false;
    if (this.statements.knownMatch.get(matchId)) return false;

    const course = seed >>> 0;
    const level = difficulty || 'normal';
    this.db.exec('BEGIN');
    try {
      for (const entry of verified) {
        this.statements.upsert.run(
          course,
          level,
          playerKey(entry, matchId),
          String(entry.name || 'Wobbler').slice(0, 16),
          Number(entry.color) || 0xff4f91,
          Math.round(entry.time),
          achievedAt,
          this.verificationVersion,
          matchId
        );
      }
      this.statements.rememberMatch.run(matchId, achievedAt);
      this.statements.trimCourse.run(course, level, course, level, this.storedPerCourse);
      this.statements.trimMatches.run(MAX_RECORDED_MATCHES);
      this.statements.trimCourses.run(this.maxCourses);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  // Верхние строки таблицы. `playerId` не обязателен: с ним у своей строки появляется признак self.
  get(seed, difficulty, limit = this.limit, playerId = null) {
    if (!Number.isSafeInteger(seed)) return [];
    const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || this.limit));
    return this.statements.top.all(seed >>> 0, difficulty || 'normal', safeLimit).map((row, index) => ({
      place: index + 1,
      name: row.display_name,
      time: row.time_ms,
      color: row.color,
      achievedAt: row.achieved_at,
      verificationVersion: row.verification_version,
      self: playerId ? row.player_id === playerId : false
    }));
  }

  // Место игрока и отставание от строки прямо над ним.
  //
  // Считается запросом, а не поиском по выданному топу: игрок вне первой десятки своё место всё
  // равно должен видеть, иначе таблица говорит ему только «тебя здесь нет».
  standing(seed, difficulty, playerId) {
    if (!playerId || !Number.isSafeInteger(seed)) return null;
    const course = seed >>> 0;
    const level = difficulty || 'normal';
    const own = this.statements.own.get(course, level, playerId);
    if (!own) return null;
    const ahead = this.statements.countAhead.get(course, level, own.time_ms, own.time_ms, own.achieved_at);
    const next = this.statements.nextAbove.get(course, level, own.time_ms, own.time_ms, own.achieved_at);
    return {
      place: Number(ahead.count) + 1,
      time: own.time_ms,
      achievedAt: own.achieved_at,
      verificationVersion: own.verification_version,
      // null у лидера: отставать ему не от кого, и ноль здесь читался бы как «идёт вровень».
      gap: next ? own.time_ms - next.time_ms : null,
      total: Number(this.statements.countCourse.get(course, level).count)
    };
  }

  clear() {
    this.db.exec('DELETE FROM leaderboard_entries');
    this.db.exec('DELETE FROM recorded_matches');
  }

  // Закрываем только своё соединение. Общее принадлежит вызывающему, и закрыть его отсюда значило
  // бы утащить за собой аккаунты.
  close() {
    if (this.ownsDb) this.db.close();
  }
}

// Ключ дедупликации. Постоянный анонимный идентификатор игрока, если клиент его прислал.
//
// Без идентификатора один человек мог занять хоть всю верхнюю часть таблицы: дедупликация шла по
// matchId, то есть отсекала лишь повторную запись одного и того же матча, а не повторные забеги
// одного и того же игрока.
//
// Запасной вариант — ключ, уникальный внутри матча. Он не склеивает забеги старого клиента между
// собой, зато и не склеивает разных игроков в одну строку, что было бы хуже.
function playerKey(entry, matchId) {
  const id = typeof entry.playerId === 'string' ? entry.playerId.trim() : '';
  if (id) return id.slice(0, 64);
  return `match:${matchId}:${entry.id || entry.name || 'anon'}`;
}

function prepare(db) {
  return {
    knownMatch: db.prepare('SELECT 1 FROM recorded_matches WHERE match_id = ?'),
    rememberMatch: db.prepare('INSERT OR IGNORE INTO recorded_matches (match_id, recorded_at) VALUES (?, ?)'),
    // Строка обновляется только при улучшении времени, поэтому имя и цвет остаются от лучшего
    // забега, а не от последнего.
    upsert: db.prepare(`
      INSERT INTO leaderboard_entries
        (course_seed, difficulty, player_id, display_name, color, time_ms, achieved_at,
         verification_version, match_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (course_seed, difficulty, player_id) DO UPDATE SET
        display_name = excluded.display_name,
        color = excluded.color,
        time_ms = excluded.time_ms,
        achieved_at = excluded.achieved_at,
        verification_version = excluded.verification_version,
        match_id = excluded.match_id
      WHERE excluded.time_ms < leaderboard_entries.time_ms
    `),
    top: db.prepare(`
      SELECT display_name, color, time_ms, achieved_at, verification_version, player_id
      FROM leaderboard_entries
      WHERE course_seed = ? AND difficulty = ?
      ORDER BY time_ms ASC, achieved_at ASC
      LIMIT ?
    `),
    own: db.prepare(`
      SELECT time_ms, achieved_at, verification_version
      FROM leaderboard_entries
      WHERE course_seed = ? AND difficulty = ? AND player_id = ?
    `),
    // Ничья разводится по времени установки: кто добежал раньше, тот и выше. Без этого два
    // одинаковых времени давали бы обоим одно место, и сумма мест не сходилась бы с числом строк.
    countAhead: db.prepare(`
      SELECT COUNT(*) AS count FROM leaderboard_entries
      WHERE course_seed = ? AND difficulty = ?
        AND (time_ms < ? OR (time_ms = ? AND achieved_at < ?))
    `),
    nextAbove: db.prepare(`
      SELECT time_ms FROM leaderboard_entries
      WHERE course_seed = ? AND difficulty = ?
        AND (time_ms < ? OR (time_ms = ? AND achieved_at < ?))
      ORDER BY time_ms DESC, achieved_at DESC
      LIMIT 1
    `),
    countCourse: db.prepare(
      'SELECT COUNT(*) AS count FROM leaderboard_entries WHERE course_seed = ? AND difficulty = ?'
    ),
    trimCourse: db.prepare(`
      DELETE FROM leaderboard_entries
      WHERE course_seed = ? AND difficulty = ? AND id NOT IN (
        SELECT id FROM leaderboard_entries
        WHERE course_seed = ? AND difficulty = ?
        ORDER BY time_ms ASC, achieved_at ASC
        LIMIT ?
      )
    `),
    trimMatches: db.prepare(`
      DELETE FROM recorded_matches WHERE match_id NOT IN (
        SELECT match_id FROM recorded_matches ORDER BY recorded_at DESC LIMIT ?
      )
    `),
    // Трассы вытесняются целиком и по времени последнего рекорда: сид случайный, число возможных
    // трасс огромно, и без потолка файл рос бы вслед за числом сыгранных матчей.
    trimCourses: db.prepare(`
      DELETE FROM leaderboard_entries WHERE (course_seed, difficulty) NOT IN (
        SELECT course_seed, difficulty FROM leaderboard_entries
        GROUP BY course_seed, difficulty
        ORDER BY MAX(achieved_at) DESC
        LIMIT ?
      )
    `)
  };
}

function courseKey(seed, difficulty) {
  return `${seed >>> 0}:${difficulty || 'normal'}`;
}

module.exports = {
  VerifiedLeaderboard,
  courseKey,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  STORED_PER_COURSE,
  VERIFICATION_VERSION
};
