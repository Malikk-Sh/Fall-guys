const DEFAULT_LIMIT = 20;
const MAX_COURSES = 256;

class VerifiedLeaderboard {
  constructor({ limit = DEFAULT_LIMIT, maxCourses = MAX_COURSES } = {}) {
    this.limit = limit;
    this.maxCourses = maxCourses;
    this.courses = new Map();
    this.matches = new Set();
    this.matchOrder = [];
  }

  record({ matchId, seed, difficulty, entries, achievedAt = Date.now() }) {
    if (!matchId || this.matches.has(matchId) || !Number.isSafeInteger(seed) || !Array.isArray(entries))
      return false;
    const verified = entries.filter(
      entry => entry?.verified && Number.isFinite(entry.time) && entry.time > 0
    );
    if (!verified.length) return false;
    const key = courseKey(seed, difficulty);
    const current = this.courses.get(key) || [];
    for (const entry of verified) {
      current.push({
        name: String(entry.name || 'Wobbler').slice(0, 16),
        time: Math.round(entry.time),
        color: Number(entry.color) || 0xff4f91,
        achievedAt
      });
    }
    current.sort((a, b) => a.time - b.time || a.achievedAt - b.achievedAt);
    this.courses.delete(key);
    this.courses.set(key, current.slice(0, this.limit));
    this.matches.add(matchId);
    this.matchOrder.push(matchId);
    while (this.matchOrder.length > this.maxCourses * this.limit)
      this.matches.delete(this.matchOrder.shift());
    while (this.courses.size > this.maxCourses) this.courses.delete(this.courses.keys().next().value);
    return true;
  }

  get(seed, difficulty, limit = this.limit) {
    const safeLimit = Math.max(1, Math.min(this.limit, Number(limit) || this.limit));
    return (this.courses.get(courseKey(seed, difficulty)) || []).slice(0, safeLimit).map((entry, index) => ({
      place: index + 1,
      ...entry
    }));
  }

  clear() {
    this.courses.clear();
    this.matches.clear();
    this.matchOrder.length = 0;
  }
}

function courseKey(seed, difficulty) {
  return `${seed >>> 0}:${difficulty || 'normal'}`;
}

module.exports = { VerifiedLeaderboard, courseKey, DEFAULT_LIMIT };
