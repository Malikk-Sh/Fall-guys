'use strict';

const packageJson = require('../package.json');

const PROCESS_STARTED_AT = new Date().toISOString();

function normalizeCommit(value) {
  const text = String(value || '').trim();
  if (!text) return 'unknown';
  return text.slice(0, 12);
}

function buildIdentity({ env = process.env, startedAt = PROCESS_STARTED_AT } = {}) {
  return {
    version: packageJson.version,
    commit: normalizeCommit(env.WOBBLE_BUILD_SHA || env.RENDER_GIT_COMMIT || env.GITHUB_SHA),
    startedAt
  };
}

module.exports = { buildIdentity, normalizeCommit, PROCESS_STARTED_AT };
