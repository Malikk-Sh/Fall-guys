// Игровые метрики: сколько раз что случилось, с разбивкой и без потерь при перезапуске.
//
// До этого счётчики были плоскими числами в памяти процесса: «падений 4312». Такое число не
// отвечает ни на один вопрос, ради которого его считают. На каком препятствии падают? Какую главу
// не проходят? Хуже на телефоне или одинаково? И всё это обнулялось при каждом развёртывании,
// то есть чаще, чем набиралась статистика.
//
// Здесь у каждого события есть измерения:
//
//   mode    — гонка или кооператив;
//   course  — сложность трассы или идентификатор главы;
//   detail  — что именно: тип сегмента, на котором упали, номер чекпоинта, где бросили,
//             отметка проверки у времени забега;
//   device  — телефон или настольный компьютер, по User-Agent при подключении.
//
// Запись идёт не в базу, а в память, и сбрасывается пачкой раз в пятнадцать секунд, вместе с
// прочей уборкой сервера. Падение в пропасть — событие частое: на живом сервере это десятки
// записей в секунду, и отдельная запись в SQLite на каждую превратила бы наблюдение за игрой
// в нагрузку на игру.

const DAY_MS = 24 * 60 * 60 * 1000;

// Сколько дней хранить. Достаточно, чтобы увидеть будни и выходные и сравнить с прошлым месяцем.
const RETENTION_DAYS = 90;

// Потолок различных ключей в памяти между сбросами.
//
// Защита не от нагрузки, а от ошибки: измерение, куда случайно попало что-то уникальное (время,
// идентификатор игрока), превратит буфер в утечку. Лишнее отбрасывается и считается отдельно —
// молча терять данные хуже, чем знать, что они потеряны.
const MAX_PENDING_KEYS = 5000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS gameplay_metrics (
    day TEXT NOT NULL,
    metric TEXT NOT NULL,
    mode TEXT NOT NULL,
    course TEXT NOT NULL,
    detail TEXT NOT NULL,
    device TEXT NOT NULL,
    samples INTEGER NOT NULL,
    total INTEGER NOT NULL,
    PRIMARY KEY (day, metric, mode, course, detail, device)
  );
`;
// Отдельного индекса по day здесь нет намеренно. День — первый столбец первичного ключа, и
// SQLite обслуживает и «выборку за неделю», и «удаление старого» его же автоиндексом (проверено
// через EXPLAIN QUERY PLAN: SEARCH … USING INDEX sqlite_autoindex… (day>?)). Второй индекс по
// тому же столбцу не ускорил бы ни один запрос, зато стоил бы вставки в B-дерево на каждую строку
// при каждом сбросе.

// Классификация устройства по User-Agent.
//
// Грубо и намеренно: различать модели телефонов незачем, а вот «палец против мыши» меняет игру
// целиком — управление, размер экрана, частоту кадров. Неизвестное считается настольным: так
// пустая строка не создаёт третью категорию, которую потом некому объяснить.
function deviceFromUserAgent(userAgent) {
  return /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(String(userAgent || '')) ? 'mobile' : 'desktop';
}

// Значения измерений приводятся к короткой строке: они идут в первичный ключ таблицы, и пустое
// или неограниченной длины значение сделало бы сводку нечитаемой.
//
// Пробелы внутри заменяются на подчёркивание — не ради корректности, а ради глаз: сводку читает
// человек, и «узкий поворот» посреди колонки из односложных значений сбивает выравнивание.
function tag(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/\s+/g, '_');
  return text ? text.slice(0, 32) : '—';
}

function dayKey(at) {
  return new Date(at).toISOString().slice(0, 10);
}

class GameplayMetrics {
  constructor({ db, now = () => Date.now(), retentionDays = RETENTION_DAYS } = {}) {
    this.db = db;
    this.now = now;
    this.retentionDays = retentionDays;
    this.pending = new Map();
    this.dropped = 0;
    this.lastPruneDay = null;
    if (db) {
      db.exec(SCHEMA);
      this.upsert = db.prepare(`
        INSERT INTO gameplay_metrics (day, metric, mode, course, detail, device, samples, total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, metric, mode, course, detail, device)
        DO UPDATE SET samples = samples + excluded.samples, total = total + excluded.total
      `);
    }
  }

  // Событие случилось. Без величины: «упал» — это факт, а не число.
  count(metric, dimensions = {}, amount = 1) {
    return this.#add(metric, dimensions, amount, 0);
  }

  // Событие случилось и принесло величину — например, время забега. Хранится сумма и количество:
  // из них получается среднее, а хранить каждое значение отдельно ради среднего незачем.
  observe(metric, value, dimensions = {}) {
    if (!Number.isFinite(value)) return false;
    return this.#add(metric, dimensions, 1, Math.round(value));
  }

  #add(metric, { mode, course, detail, device } = {}, samples, total) {
    if (!metric || !Number.isFinite(samples) || samples < 1) return false;
    const dimensions = [tag(metric), tag(mode), tag(course), tag(detail), tag(device)];
    // Ключ буфера — JSON, а не склейка через разделитель. Склейка тоже работала бы: tag выше
    // убирает пробелы, и разделителю неоткуда взяться внутри значения. Но это связывает две
    // независимые вещи — правило чтения ключа и то, что именно tag сейчас вычищает, — и стоит
    // ослабить tag, как измерения начнут разъезжаться, причём молча. JSON от этого не зависит.
    const key = JSON.stringify(dimensions);
    const existing = this.pending.get(key);
    if (existing) {
      existing.samples += samples;
      existing.total += total;
      return true;
    }
    if (this.pending.size >= MAX_PENDING_KEYS) {
      this.dropped++;
      return false;
    }
    this.pending.set(key, { dimensions, samples, total });
    return true;
  }

  // Сброс накопленного в базу. Возвращает число записанных ключей — по нему видно, работает ли
  // сброс вообще.
  flush() {
    if (!this.db || !this.pending.size) return 0;
    const day = dayKey(this.now());
    const entries = [...this.pending.values()];
    this.pending.clear();
    // Одна транзакция на пачку: без неё SQLite делает по фиксации на строку, и сброс сотни ключей
    // стоит сотни обращений к диску.
    this.db.exec('BEGIN');
    try {
      for (const value of entries) {
        this.upsert.run(day, ...value.dimensions, value.samples, value.total);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.#prune(day);
    return entries.length;
  }

  // Старые дни удаляются раз в сутки, а не при каждом сбросе: за один день удалять нечего, а
  // запрос всё равно проходит по таблице.
  #prune(day) {
    if (this.lastPruneDay === day) return;
    this.lastPruneDay = day;
    const cutoff = dayKey(this.now() - this.retentionDays * DAY_MS);
    this.db.prepare('DELETE FROM gameplay_metrics WHERE day < ?').run(cutoff);
  }

  // Сводка за последние дни. Строки идут от частого к редкому: смотреть их будет человек, и
  // первым он должен увидеть то, что случается чаще всего.
  summary({ days = 7, limit = 200 } = {}) {
    const from = dayKey(this.now() - (Math.max(1, days) - 1) * DAY_MS);
    // Форма ответа одна и без базы: потребителю не должно приходиться различать «метрик нет» и
    // «метрики выключены» по отсутствию поля.
    if (!this.db) return { days, from, dropped: this.dropped, rows: [] };
    this.flush();
    // Уборка живёт в flush, а тот выходит сразу, когда копить было нечего. На затихшем сервере
    // старые дни так и остались бы лежать — поэтому просмотр сводки тоже убирает за собой.
    this.#prune(dayKey(this.now()));
    const rows = this.db
      .prepare(
        `SELECT metric, mode, course, detail, device,
                SUM(samples) AS samples, SUM(total) AS total
           FROM gameplay_metrics
          WHERE day >= ?
          GROUP BY metric, mode, course, detail, device
          ORDER BY samples DESC
          LIMIT ?`
      )
      .all(from, Math.max(1, Math.min(1000, limit)));
    return {
      days,
      from,
      dropped: this.dropped,
      rows: rows.map(row => ({
        metric: row.metric,
        mode: row.mode,
        course: row.course,
        detail: row.detail,
        device: row.device,
        samples: Number(row.samples),
        // Среднее показывается только там, где величина есть: у простых счётчиков total всегда 0,
        // и «среднее 0» читалось бы как настоящий ноль.
        average: Number(row.total) ? Math.round(Number(row.total) / Number(row.samples)) : null
      }))
    };
  }
}

module.exports = { GameplayMetrics, deviceFromUserAgent };
