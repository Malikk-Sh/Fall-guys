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
//
// 2 — race-проверка узнала геометрию трассы и историю пакетов.
// 3 — competitive co-op получил собственный CoopMovementAudit по общей разметке глав: sustained
// speed, support/height, checkpoint regions, минимумы участков и серверные исключения механик.
// Старые co-op строки версии 2 были только server-timed и не могут считаться проверенными v3.
const VERIFICATION_VERSION = 3;

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
    mode TEXT NOT NULL,
    course_key TEXT NOT NULL,
    player_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    color INTEGER NOT NULL,
    time_ms INTEGER NOT NULL,
    achieved_at INTEGER NOT NULL,
    verification_version INTEGER NOT NULL,
    match_id TEXT NOT NULL,
    UNIQUE (mode, course_key, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_entries_course
    ON leaderboard_entries (mode, course_key, time_ms, achieved_at);
  CREATE TABLE IF NOT EXISTS recorded_matches (
    match_id TEXT PRIMARY KEY,
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_matches_time ON recorded_matches (recorded_at);
`;

// Перенос со старой схемы, где трасса задавалась парой (сид, сложность).
//
// Пара работала, пока таблица была одна — гоночная. Кооперативная глава сидом не описывается: у
// неё рукотворная разметка и имя вместо числа. Поэтому ключ обобщён до пары (режим, ключ трассы),
// где у гонки ключ — «сид:сложность», а у коопа — идентификатор главы. Та же пара уже используется
// для личных рекордов в accounts.js, так что обе таблицы теперь называют трассу одинаково.
//
// Переносить, а не начинать заново: в таблице лежат рекорды живых людей, и «мы поменяли схему»
// для них означало бы просто исчезновение результата.
function migrate(db) {
  const columns = db.prepare('PRAGMA table_info(leaderboard_entries)').all();
  // Таблицы ещё нет — её создаст SCHEMA уже в новом виде. Либо она уже новая.
  if (!columns.length || columns.some(column => column.name === 'course_key')) return false;

  db.exec('BEGIN');
  try {
    // Индекс носит то же имя, что и новый, и уезжает вместе с переименованной таблицей — иначе
    // CREATE INDEX ниже наткнулся бы на занятое имя.
    db.exec('DROP INDEX IF EXISTS idx_entries_course');
    db.exec('ALTER TABLE leaderboard_entries RENAME TO leaderboard_entries_v1');
    db.exec(SCHEMA);
    db.exec(`
      INSERT INTO leaderboard_entries
        (mode, course_key, player_id, display_name, color, time_ms, achieved_at,
         verification_version, match_id)
      SELECT 'race', course_seed || ':' || difficulty, player_id, display_name, color, time_ms,
             achieved_at, verification_version, match_id
      FROM leaderboard_entries_v1
    `);
    db.exec('DROP TABLE leaderboard_entries_v1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

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
    this.migrated = migrate(this.db);
    this.db.exec(SCHEMA);
    this.staleCoopPruned = Number(
      this.db
        .prepare("DELETE FROM leaderboard_entries WHERE mode = 'coop' AND verification_version < ?")
        .run(this.verificationVersion).changes || 0
    );
    this.statements = prepare(this.db);
  }

  // Возвращает true, если матч учтён впервые. Записи внутри матча складываются по лучшему времени
  // каждого игрока: один человек занимает в таблице ровно одну строку на трассу.
  record({ matchId, mode, courseKey, entries, achievedAt = Date.now() }) {
    if (!matchId || !mode || !courseKey || !Array.isArray(entries)) return false;
    const verified = entries.filter(
      entry => entry?.verified && Number.isFinite(entry.time) && entry.time > 0
    );
    if (!verified.length) return false;
    if (this.statements.knownMatch.get(matchId)) return false;

    const course = String(courseKey);
    const level = String(mode);
    this.db.exec('BEGIN');
    try {
      for (const entry of verified) {
        this.statements.upsert.run(
          level,
          course,
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
      this.statements.trimCourse.run(level, course, level, course, this.storedPerCourse);
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
  get(mode, courseKey, limit = this.limit, playerId = null) {
    if (!mode || !courseKey) return [];
    const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || this.limit));
    return this.statements.top.all(String(mode), String(courseKey), safeLimit).map((row, index) => ({
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
  standing(mode, courseKey, playerId) {
    if (!playerId || !mode || !courseKey) return null;
    const course = String(courseKey);
    const level = String(mode);
    const own = this.statements.own.get(level, course, playerId);
    if (!own) return null;
    const ahead = this.statements.countAhead.get(level, course, own.time_ms, own.time_ms, own.achieved_at);
    const next = this.statements.nextAbove.get(level, course, own.time_ms, own.time_ms, own.achieved_at);
    return {
      place: Number(ahead.count) + 1,
      time: own.time_ms,
      achievedAt: own.achieved_at,
      verificationVersion: own.verification_version,
      // null у лидера: отставать ему не от кого, и ноль здесь читался бы как «идёт вровень».
      gap: next ? own.time_ms - next.time_ms : null,
      total: Number(this.statements.countCourse.get(level, course).count)
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
        (mode, course_key, player_id, display_name, color, time_ms, achieved_at,
         verification_version, match_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (mode, course_key, player_id) DO UPDATE SET
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
      WHERE mode = ? AND course_key = ?
      ORDER BY time_ms ASC, achieved_at ASC
      LIMIT ?
    `),
    own: db.prepare(`
      SELECT time_ms, achieved_at, verification_version
      FROM leaderboard_entries
      WHERE mode = ? AND course_key = ? AND player_id = ?
    `),
    // Ничья разводится по времени установки: кто добежал раньше, тот и выше. Без этого два
    // одинаковых времени давали бы обоим одно место, и сумма мест не сходилась бы с числом строк.
    countAhead: db.prepare(`
      SELECT COUNT(*) AS count FROM leaderboard_entries
      WHERE mode = ? AND course_key = ?
        AND (time_ms < ? OR (time_ms = ? AND achieved_at < ?))
    `),
    nextAbove: db.prepare(`
      SELECT time_ms FROM leaderboard_entries
      WHERE mode = ? AND course_key = ?
        AND (time_ms < ? OR (time_ms = ? AND achieved_at < ?))
      ORDER BY time_ms DESC, achieved_at DESC
      LIMIT 1
    `),
    countCourse: db.prepare(
      'SELECT COUNT(*) AS count FROM leaderboard_entries WHERE mode = ? AND course_key = ?'
    ),
    trimCourse: db.prepare(`
      DELETE FROM leaderboard_entries
      WHERE mode = ? AND course_key = ? AND id NOT IN (
        SELECT id FROM leaderboard_entries
        WHERE mode = ? AND course_key = ?
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
    //
    // Вытесняются только гоночные. Кооперативных глав ровно столько, сколько написано руками, —
    // они не растут и вытеснять их незачем. Хуже того: гоночные трассы появляются потоком, и общий
    // потолок рано или поздно вытолкнул бы главу вместе с рекордами всех, кто её проходил.
    trimCourses: db.prepare(`
      DELETE FROM leaderboard_entries
      WHERE mode = 'race' AND course_key NOT IN (
        SELECT course_key FROM leaderboard_entries
        WHERE mode = 'race'
        GROUP BY course_key
        ORDER BY MAX(achieved_at) DESC
        LIMIT ?
      )
    `)
  };
}

// Как называется трасса в таблице. Гонка описывается сидом и сложностью, кооперативная глава —
// своим идентификатором. Та же запись используется для личных рекордов в accounts.js: две таблицы,
// называющие одну трассу по-разному, рано или поздно разъедутся.
function raceCourseKey(seed, difficulty) {
  return `${seed >>> 0}:${difficulty || 'normal'}`;
}

module.exports = {
  VerifiedLeaderboard,
  raceCourseKey,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  STORED_PER_COURSE,
  VERIFICATION_VERSION
};
