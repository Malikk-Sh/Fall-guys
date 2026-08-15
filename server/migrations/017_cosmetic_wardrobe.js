module.exports = {
  version: 17,
  sql: `
    -- Слот «спина» появился вместе с рюкзаками и крыльями. Колонка nullable и без значения по
    -- умолчанию: у существующих строк она станет NULL, то есть «слот пуст», а остальные слоты
    -- сохранённого образа не трогаются вовсе.
    ALTER TABLE account_loadout ADD COLUMN back TEXT;

    -- Эмоции хранятся строками, а не JSON-полем.
    --
    -- Соблазн был положить массив из четырёх ID одним текстом, но тогда содержимое ячеек
    -- перестало бы быть данными базы и стало бы непроверяемой строкой, пришедшей от клиента.
    -- Отдельная таблица с фиксированной позицией делает форму частью схемы: позиция — целое,
    -- предмет — ссылка на канонический ID, дубликат в одной ячейке невозможен по первичному ключу.
    CREATE TABLE IF NOT EXISTS account_emote_loadout (
      account_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      cosmetic_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, position),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_account_emote_loadout_account
      ON account_emote_loadout (account_id, position);
  `
};
