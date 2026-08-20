'use strict';

const { GAME_MODE, courseKeyFor } = require('../shared/protocol.js');
const { COOP_CHAPTER_IDS } = require('../shared/coopChapters.js');
const { VERIFICATION_VERSION } = require('./verifiedLeaderboard');
const { safeDifficulty } = require('./gameRules');

function requestedPlayerId(value) {
  return typeof value === 'string' ? value.slice(0, 64) : null;
}

function installLeaderboardRoutes(app, { verifiedLeaderboard }) {
  app.get('/leaderboard', (req, res) => {
    const seedText = String(req.query.seed || '');
    const seed = Number(seedText);
    const difficulty = safeDifficulty(req.query.difficulty);
    if (!/^\d{1,10}$/.test(seedText) || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
      return res.status(400).json({ ok: false, error: 'invalid-seed' });
    // Идентификатор нужен, чтобы посчитать место игрока и отставание. Он же помечает его строку в
    // выдаче. Приходит параметром запроса, а не заголовком: страница лобби обновляет таблицу обычным
    // fetch, и лишний слой тут ничего не даёт.
    const playerId = requestedPlayerId(req.query.playerId);
    const key = courseKeyFor(GAME_MODE.RACE, { seed, difficulty });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      mode: GAME_MODE.RACE,
      seed: seed >>> 0,
      difficulty,
      verificationVersion: VERIFICATION_VERSION,
      entries: verifiedLeaderboard.get(GAME_MODE.RACE, key, req.query.limit, playerId),
      // null, если игрок эту трассу ещё не проходил, — отдельно от entries, потому что его строка
      // может быть далеко за пределами показанной десятки.
      standing: verifiedLeaderboard.standing(GAME_MODE.RACE, key, playerId)
    });
  });

  // Таблица кооперативных глав.
  //
  // Отдельным адресом, а не параметром к /leaderboard: у гонки трасса задаётся сидом и сложностью,
  // у главы — идентификатором, и склеивать два разных набора параметров в один маршрут значило бы
  // проверять их вперемешку.
  //
  // Время и движение здесь проверяет сервер. Для рукотворных глав используется отдельный
  // CoopMovementAudit: он читает ту же data-driven разметку, что строит клиент, и проверяет
  // систематическую скорость, опоры, высоту, checkpoint regions и физические минимумы, сохраняя
  // узкие исключения только для серверно подтверждённых механик.
  app.get('/leaderboard/coop', (req, res) => {
    const chapterId = typeof req.query.chapter === 'string' ? req.query.chapter : '';
    if (!COOP_CHAPTER_IDS.includes(chapterId))
      return res.status(400).json({ ok: false, error: 'invalid-chapter' });
    const playerId = requestedPlayerId(req.query.playerId);
    const key = courseKeyFor(GAME_MODE.COOP, { chapterId });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      mode: GAME_MODE.COOP,
      chapter: chapterId,
      movementVerified: true,
      verificationVersion: VERIFICATION_VERSION,
      entries: verifiedLeaderboard.get(GAME_MODE.COOP, key, req.query.limit, playerId),
      standing: verifiedLeaderboard.standing(GAME_MODE.COOP, key, playerId)
    });
  });
}

module.exports = Object.freeze({ installLeaderboardRoutes });
