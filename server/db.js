// Одно соединение с базой на весь процесс.
//
// Таблица рекордов и аккаунты живут в одном файле и открываются одним соединением намеренно. Два
// соединения к одному файлу SQLite формально допускает, но тогда запись из одного блокирует другое,
// и редкие «database is locked» появлялись бы там, где их никто не ждёт.

const { DatabaseSync } = require('node:sqlite');

function openDatabase(file = ':memory:') {
  const db = new DatabaseSync(file);
  // Privacy-retained tables rely on physical deletion, not only logical DELETE visibility.
  // secure_delete overwrites deleted cells before pages can be reused. WAL frames are truncated
  // by the owning diagnostics service after bounded cleanup batches.
  db.exec('PRAGMA secure_delete = ON');
  // Для файла на диске: WAL переживает падение процесса без потери уже записанных строк, а NORMAL
  // убирает fsync на каждой вставке. В памяти оба параметра бессмысленны.
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }
  return db;
}

module.exports = { openDatabase };
