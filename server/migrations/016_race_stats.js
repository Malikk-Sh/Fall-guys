module.exports = {
  version: 16,
  sql: `
    -- Итоги онлайн-гонок по аккаунту.
    --
    -- Отдельная таблица, а не колонки в account_stats: та описывает кооперативную кампанию, и
    -- смешивать в ней два независимых режима значило бы каждый раз выяснять, какие поля к какому
    -- относятся. Строка заводится при первом финише, а не при регистрации.
    --
    -- Место хранится не как таковое, а разложенным на события, которые кому-то что-то дают:
    -- сколько раз финишировал, сколько раз был в тройке, сколько раз первым. Так награда за
    -- «пьедестал» считается одним сравнением, а не проходом по истории забегов, которой нет.
    CREATE TABLE IF NOT EXISTS account_race_stats (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      finishes INTEGER NOT NULL DEFAULT 0,
      podiums INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      best_place INTEGER,
      updated_at INTEGER NOT NULL,
      CHECK (finishes >= 0),
      CHECK (podiums >= 0),
      CHECK (wins >= 0),
      CHECK (podiums <= finishes),
      CHECK (wins <= finishes),
      -- Здесь намеренно НЕТ проверки wins <= podiums, хотя она напрашивается.
      --
      -- Победа и пьедестал считаются по разным порогам: выиграть можно вдвоём, а пьедестал
      -- начинается с трёх дошедших — иначе «третье место» существовало бы там, где третьего нет.
      -- Значит победа в парном забеге увеличивает wins и не увеличивает podiums, и такое
      -- ограничение отвергало бы совершенно нормальный результат.
      CHECK (best_place IS NULL OR best_place >= 1)
    );
  `
};
