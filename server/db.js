// Открытие базы. Одно соединение на процесс — но процессов больше одного.
//
// Раньше здесь было написано, что база открывается одним соединением на всю систему, и второе
// соединение назвали бы источником редких «database is locked». С появлением отдельного control
// plane (он живёт своим процессом и ходит в тот же файл) это перестало быть правдой: писателей у
// файла теперь пять — игра, панель, бэкап и два CLI.
//
// Из этого следует то, ради чего и написан этот комментарий. По умолчанию SQLite при занятом файле
// НЕ ЖДЁТ: занятая база возвращает ошибку немедленно, тем же тактом. Значит запись из панели,
// совпавшая по времени с записью из игры, роняла игровую запись — а та в свою очередь поднималась
// исключением из таймера и убивала процесс вместе со всеми идущими забегами. Ожидание — не
// оптимизация, а условие того, чтобы два процесса вообще могли делить один файл.

const { DatabaseSync } = require('node:sqlite');

// Сколько ждать освобождения файла. Пять секунд — с большим запасом: писатели здесь короткие
// (вставка строки, сброс пачки метрик), и реальное ожидание измеряется миллисекундами. Запас нужен
// на редкий случай, когда бэкап снимает снимок целиком.
//
// Панель намеренно задаёт себе меньше (см. controlPlane.js): администратору лучше увидеть ошибку,
// чем смотреть на замерший экран, а игроку — наоборот, лучше подождать, чем вылететь из забега.
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

function openDatabase(file = ':memory:', { busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
  const db = new DatabaseSync(file);
  // Privacy-retained tables rely on physical deletion, not only logical DELETE visibility.
  // secure_delete overwrites deleted cells before pages can be reused. WAL frames are truncated
  // by the owning diagnostics service after bounded cleanup batches.
  db.exec('PRAGMA secure_delete = ON');
  // Для файла на диске: WAL переживает падение процесса без потери уже записанных строк, а NORMAL
  // убирает fsync на каждой вставке. В памяти оба параметра бессмысленны — как и ожидание блокировки:
  // базу в памяти никто снаружи процесса не откроет.
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    const timeout =
      Number.isFinite(busyTimeoutMs) && busyTimeoutMs >= 0
        ? Math.floor(busyTimeoutMs)
        : DEFAULT_BUSY_TIMEOUT_MS;
    db.exec(`PRAGMA busy_timeout = ${timeout}`);
  }
  return db;
}

module.exports = { openDatabase, DEFAULT_BUSY_TIMEOUT_MS };
