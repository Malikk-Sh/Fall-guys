'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 90;
const MAX_ROWS = 1000;
const TREND_METRICS = Object.freeze(['match_started', 'match_finished', 'match_abandoned', 'fall']);

function dayKey(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function clampDays(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 7;
  return Math.min(parsed, MAX_DAYS);
}

function clampLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 300;
  return Math.min(parsed, MAX_ROWS);
}

function normalizeFilter(value) {
  const text = String(value || 'all').trim();
  if (!text || text === 'all') return 'all';
  return text.slice(0, 32);
}

function filterArgs(filters) {
  return [filters.mode, filters.mode, filters.course, filters.course, filters.device, filters.device];
}

function summarizeKpis(rows) {
  const samples = metric =>
    rows.filter(row => row.metric === metric).reduce((sum, row) => sum + Number(row.samples || 0), 0);
  const finishRows = detail => rows.filter(row => row.metric === 'finish_time' && row.detail === detail);
  const average = list => {
    const count = list.reduce((sum, row) => sum + Number(row.samples || 0), 0);
    const total = list.reduce((sum, row) => sum + Number(row.total || 0), 0);
    return count > 0 ? Math.round(total / count) : null;
  };
  const started = samples('match_started');
  const finished = samples('match_finished');
  return {
    started,
    finished,
    completionPercent: started > 0 ? Math.round((finished / started) * 1000) / 10 : null,
    abandoned: samples('match_abandoned'),
    falls: samples('fall'),
    verifiedFinishes: finishRows('verified').reduce((sum, row) => sum + Number(row.samples || 0), 0),
    unverifiedFinishes: finishRows('unverified').reduce((sum, row) => sum + Number(row.samples || 0), 0),
    verifiedAverageMs: average(finishRows('verified'))
  };
}

function buildTrend(rows, from, days) {
  const byDay = new Map();
  for (let offset = 0; offset < days; offset += 1) {
    const day = dayKey(Date.parse(`${from}T00:00:00Z`) + offset * DAY_MS);
    byDay.set(day, {
      day,
      matchStarted: 0,
      matchFinished: 0,
      matchAbandoned: 0,
      falls: 0
    });
  }
  const fieldFor = {
    match_started: 'matchStarted',
    match_finished: 'matchFinished',
    match_abandoned: 'matchAbandoned',
    fall: 'falls'
  };
  for (const row of rows) {
    const point = byDay.get(row.day);
    const field = fieldFor[row.metric];
    if (point && field) point[field] += Number(row.samples || 0);
  }
  return [...byDay.values()];
}

class AdminAnalytics {
  constructor({ db, gameplay, now } = {}) {
    if (!db) throw new Error('AdminAnalytics requires an open database');
    if (!gameplay || typeof gameplay.summary !== 'function') {
      throw new Error('AdminAnalytics requires GameplayMetrics');
    }
    this.db = db;
    this.gameplay = gameplay;
    this.now =
      typeof now === 'function' ? now : typeof gameplay.now === 'function' ? gameplay.now : () => Date.now();
    this.statements = null;
  }

  report({ days = 7, limit = 300, mode = 'all', course = 'all', device = 'all' } = {}) {
    const periodDays = clampDays(days);
    const rowLimit = clampLimit(limit);
    const filters = {
      mode: normalizeFilter(mode),
      course: normalizeFilter(course),
      device: normalizeFilter(device)
    };

    // summary() flushes pending in-memory metrics and applies the normal retention policy before the
    // admin report reads SQLite. The tiny limit is intentional: this call is for lifecycle semantics,
    // not for the returned rows.
    this.gameplay.summary({ days: periodDays, limit: 1 });
    this.statements ||= prepare(this.db);

    const now = this.now();
    const from = dayKey(now - (periodDays - 1) * DAY_MS);
    const previousFrom = dayKey(now - (periodDays * 2 - 1) * DAY_MS);
    const previousTo = dayKey(now - periodDays * DAY_MS);
    const args = filterArgs(filters);

    const rawRows = this.statements.rows.all(from, ...args, rowLimit + 1);
    const truncated = rawRows.length > rowLimit;
    const rows = rawRows.slice(0, rowLimit).map(row => ({
      metric: row.metric,
      mode: row.mode,
      course: row.course,
      detail: row.detail,
      device: row.device,
      samples: Number(row.samples || 0),
      average: Number(row.total) ? Math.round(Number(row.total) / Number(row.samples)) : null
    }));

    const currentKpiRows = this.statements.kpis.all(from, ...args);
    const previousKpiRows = this.statements.kpisBetween.all(previousFrom, previousTo, ...args);
    const trendRows = this.statements.trend.all(from, ...args);
    const fallHotspots = this.statements.hotspots.all(from, ...args, 'fall', 12).map(toHotspot);
    const abandonHotspots = this.statements.hotspots.all(from, ...args, 'match_abandoned', 12).map(toHotspot);

    const dimensions = this.statements.dimensions.all(from);
    const options = {
      modes: [...new Set(dimensions.map(row => row.mode))].sort(),
      courses: [...new Set(dimensions.map(row => row.course))].sort(),
      devices: [...new Set(dimensions.map(row => row.device))].sort()
    };

    return {
      days: periodDays,
      from,
      previousFrom,
      previousTo,
      dropped: Number(this.gameplay.dropped || 0),
      filters,
      options,
      kpis: {
        current: summarizeKpis(currentKpiRows),
        previous: summarizeKpis(previousKpiRows)
      },
      trend: buildTrend(trendRows, from, periodDays),
      hotspots: {
        falls: fallHotspots,
        abandons: abandonHotspots
      },
      rows,
      truncated
    };
  }
}

function toHotspot(row) {
  return {
    course: row.course,
    detail: row.detail,
    device: row.device,
    samples: Number(row.samples || 0)
  };
}

function prepare(db) {
  const filtered = `
    (? = 'all' OR mode = ?)
    AND (? = 'all' OR course = ?)
    AND (? = 'all' OR device = ?)
  `;
  return {
    rows: db.prepare(`
      SELECT metric, mode, course, detail, device,
             SUM(samples) AS samples, SUM(total) AS total
      FROM gameplay_metrics
      WHERE day >= ? AND ${filtered}
      GROUP BY metric, mode, course, detail, device
      ORDER BY samples DESC, metric ASC, mode ASC, course ASC, detail ASC, device ASC
      LIMIT ?
    `),
    kpis: db.prepare(`
      SELECT metric, detail, SUM(samples) AS samples, SUM(total) AS total
      FROM gameplay_metrics
      WHERE day >= ? AND ${filtered}
      GROUP BY metric, detail
    `),
    kpisBetween: db.prepare(`
      SELECT metric, detail, SUM(samples) AS samples, SUM(total) AS total
      FROM gameplay_metrics
      WHERE day >= ? AND day <= ? AND ${filtered}
      GROUP BY metric, detail
    `),
    trend: db.prepare(`
      SELECT day, metric, SUM(samples) AS samples
      FROM gameplay_metrics
      WHERE day >= ? AND ${filtered}
        AND metric IN ('match_started', 'match_finished', 'match_abandoned', 'fall')
      GROUP BY day, metric
      ORDER BY day ASC, metric ASC
    `),
    hotspots: db.prepare(`
      SELECT course, detail, device, SUM(samples) AS samples
      FROM gameplay_metrics
      WHERE day >= ? AND ${filtered} AND metric = ?
      GROUP BY course, detail, device
      ORDER BY samples DESC, course ASC, detail ASC, device ASC
      LIMIT ?
    `),
    dimensions: db.prepare(`
      SELECT DISTINCT mode, course, device
      FROM gameplay_metrics
      WHERE day >= ?
      ORDER BY mode ASC, course ASC, device ASC
    `)
  };
}

module.exports = {
  AdminAnalytics,
  MAX_DAYS,
  MAX_ROWS,
  TREND_METRICS,
  clampDays,
  normalizeFilter,
  summarizeKpis
};
