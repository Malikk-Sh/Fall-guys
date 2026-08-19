// Automated reliability gate around loadProbe.mjs.
//
// The generator remains useful on its own. This wrapper adds deterministic assertions for CI,
// configurable performance budgets, and a compact Markdown summary. Nightly supplies the hard
// budgets through environment variables so local/ad-hoc runs can remain telemetry-only unless the
// caller deliberately opts into the same policy.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOMS = Math.max(1, Number(process.argv[2] || 24));
const SECONDS = Math.max(1, Number(process.argv[3] || 12));
const SUMMARY_PATH = String(process.env.WOBBLE_LOAD_SUMMARY_PATH || '').trim() || null;
const EXTERNAL_RESULT_PATH = String(process.env.WOBBLE_LOAD_RESULT_PATH || '').trim() || null;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalPositiveNumber(env, name) {
  const raw = String(env[name] ?? '').trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!finiteNumber(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function loadBudgetConfig(env = process.env) {
  const config = {
    baselineEventLoopP95Ms: optionalPositiveNumber(env, 'WOBBLE_LOAD_BASELINE_EVENT_LOOP_P95_MS'),
    warningEventLoopP95Ms: optionalPositiveNumber(env, 'WOBBLE_LOAD_WARN_EVENT_LOOP_P95_MS'),
    maxEventLoopP95Ms: optionalPositiveNumber(env, 'WOBBLE_LOAD_MAX_EVENT_LOOP_P95_MS'),
    baselineRssMb: optionalPositiveNumber(env, 'WOBBLE_LOAD_BASELINE_RSS_MB'),
    maxRssMb: optionalPositiveNumber(env, 'WOBBLE_LOAD_MAX_RSS_MB')
  };

  if (
    config.warningEventLoopP95Ms !== null &&
    config.maxEventLoopP95Ms !== null &&
    config.warningEventLoopP95Ms >= config.maxEventLoopP95Ms
  ) {
    throw new Error(
      `WOBBLE_LOAD_WARN_EVENT_LOOP_P95_MS (${config.warningEventLoopP95Ms}) must be below ` +
        `WOBBLE_LOAD_MAX_EVENT_LOOP_P95_MS (${config.maxEventLoopP95Ms})`
    );
  }

  return config;
}

function metricStatus(value, warningBudget, hardBudget) {
  if (!finiteNumber(value)) return 'FAIL';
  if (finiteNumber(hardBudget) && value > hardBudget) return 'FAIL';
  if (finiteNumber(warningBudget) && value > warningBudget) return 'WARN';
  return 'PASS';
}

function formatNumber(value, digits = 1) {
  if (!finiteNumber(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function referenceWithDelta(value, baseline, unit, digits = 1) {
  if (!finiteNumber(baseline) || !finiteNumber(value)) return '—';
  const delta = value - baseline;
  const sign = delta >= 0 ? '+' : '';
  return `${formatNumber(baseline, digits)} ${unit} (Δ ${sign}${formatNumber(delta, digits)} ${unit})`;
}

function budgetLabel(warningBudget, hardBudget, unit) {
  const labels = [];
  if (finiteNumber(warningBudget)) labels.push(`warn ${formatNumber(warningBudget)} ${unit}`);
  if (finiteNumber(hardBudget)) labels.push(`fail ${formatNumber(hardBudget)} ${unit}`);
  return labels.length ? labels.join(' / ') : 'telemetry only';
}

export function evaluateLoadResult(result, budgets = {}) {
  const failures = [];
  const warnings = [];
  const initial = result?.initial || {};
  const after = result?.after || {};
  const deltas = result?.deltas || {};
  const requestedRooms = Number(result?.roomsRequested);
  const requestedPlayers = Number(result?.playersRequested);

  if (!Number.isInteger(requestedRooms) || requestedRooms < 1) {
    failures.push('result is missing a valid roomsRequested value');
  }
  if (!Number.isInteger(requestedPlayers) || requestedPlayers !== requestedRooms * 2) {
    failures.push('playersRequested does not match two players per room');
  }

  if (Number.isInteger(initial.rooms) && Number.isInteger(after.rooms)) {
    const expectedRooms = initial.rooms + requestedRooms;
    if (after.rooms !== expectedRooms) {
      failures.push(`expected ${expectedRooms} rooms after load, got ${after.rooms}`);
    }
  } else {
    failures.push('room counts are missing from load result');
  }

  if (Number.isInteger(initial.players) && Number.isInteger(after.players)) {
    const expectedPlayers = initial.players + requestedPlayers;
    if (after.players !== expectedPlayers) {
      failures.push(`expected ${expectedPlayers} players after load, got ${after.players}`);
    }
  } else {
    failures.push('player counts are missing from load result');
  }

  for (const name of ['invalidMessages', 'socketSendFailures', 'handlerErrors', 'capacityRejected']) {
    if (!finiteNumber(deltas[name])) failures.push(`${name} delta is missing`);
    else if (deltas[name] !== 0) failures.push(`${name} delta must be 0, got ${deltas[name]}`);
  }

  if (result?.readiness?.ok !== true || result?.readiness?.status !== 200) {
    failures.push(`server was not ready after load (HTTP ${result?.readiness?.status ?? 'unknown'})`);
  }
  if (after.load?.overloaded === true) failures.push('server reported event-loop overload after load');

  const eventLoopP95Ms = after.load?.eventLoopP95Ms;
  if (!finiteNumber(eventLoopP95Ms)) {
    failures.push('event-loop p95 metric is missing');
  } else {
    if (finiteNumber(budgets.maxEventLoopP95Ms) && eventLoopP95Ms > budgets.maxEventLoopP95Ms) {
      failures.push(`event-loop p95 ${eventLoopP95Ms} ms > hard budget ${budgets.maxEventLoopP95Ms} ms`);
    } else if (
      finiteNumber(budgets.warningEventLoopP95Ms) &&
      eventLoopP95Ms > budgets.warningEventLoopP95Ms
    ) {
      warnings.push(
        `event-loop p95 ${eventLoopP95Ms} ms > warning budget ${budgets.warningEventLoopP95Ms} ms`
      );
    }
  }

  const rssMb = after.load?.rssMb;
  if (!finiteNumber(rssMb)) {
    failures.push('RSS metric is missing');
  } else if (finiteNumber(budgets.maxRssMb) && rssMb > budgets.maxRssMb) {
    failures.push(`RSS ${rssMb} MB > hard budget ${budgets.maxRssMb} MB`);
  }

  return { ok: failures.length === 0, failures, warnings, budgets };
}

export function markdownSummary(result, evaluation) {
  const after = result.after || {};
  const deltas = result.deltas || {};
  const budgets = evaluation.budgets || {};
  const eventLoopP95Ms = after.load?.eventLoopP95Ms;
  const rssMb = after.load?.rssMb;
  const performanceRows = [
    [
      'Event-loop p95',
      finiteNumber(eventLoopP95Ms) ? `${formatNumber(eventLoopP95Ms)} ms` : '—',
      referenceWithDelta(eventLoopP95Ms, budgets.baselineEventLoopP95Ms, 'ms'),
      budgetLabel(budgets.warningEventLoopP95Ms, budgets.maxEventLoopP95Ms, 'ms'),
      metricStatus(eventLoopP95Ms, budgets.warningEventLoopP95Ms, budgets.maxEventLoopP95Ms)
    ],
    [
      'RSS',
      finiteNumber(rssMb) ? `${formatNumber(rssMb)} MB` : '—',
      referenceWithDelta(rssMb, budgets.baselineRssMb, 'MB'),
      budgetLabel(null, budgets.maxRssMb, 'MB'),
      metricStatus(rssMb, null, budgets.maxRssMb)
    ]
  ];
  const functionalRows = [
    ['Rooms', `${after.rooms ?? '—'} (${result.roomsRequested} requested)`],
    ['Players', `${after.players ?? '—'} (${result.playersRequested} requested)`],
    ['Duration', `${result.seconds}s`],
    ['Ready after load', result.readiness?.ok ? 'yes' : `no (HTTP ${result.readiness?.status ?? '—'})`],
    ['Invalid messages Δ', `${deltas.invalidMessages ?? '—'}`],
    ['Socket send failures Δ', `${deltas.socketSendFailures ?? '—'}`],
    ['Handler errors Δ', `${deltas.handlerErrors ?? '—'}`],
    ['Capacity rejections Δ', `${deltas.capacityRejected ?? '—'}`],
    ['Snapshots skipped for load Δ', `${deltas.snapshotsSkippedForLoad ?? '—'}`]
  ];
  const resultLabel = evaluation.ok
    ? evaluation.warnings.length
      ? `PASS (${evaluation.warnings.length} warning)`
      : 'PASS'
    : 'FAIL';
  const lines = [
    '### Server WebSocket load gate',
    '',
    `**Result:** ${resultLabel}`,
    '',
    '#### Performance budgets',
    '',
    '| Metric | Current | Reference / delta | Budget | Status |',
    '| --- | --- | --- | --- | --- |',
    ...performanceRows.map(row => `| ${row.join(' | ')} |`),
    '',
    '#### Functional gates',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    ...functionalRows.map(([name, value]) => `| ${name} | ${value} |`),
    '',
    '> Performance budgets are configured with `WOBBLE_LOAD_*` environment variables. If hard budgets are omitted, an ad-hoc local run keeps those metrics telemetry-only.'
  ];

  if (evaluation.warnings.length) {
    lines.push('', '**Warnings:**', ...evaluation.warnings.map(warning => `- ${warning}`));
  }
  if (!evaluation.ok) {
    lines.push('', '**Failures:**', ...evaluation.failures.map(failure => `- ${failure}`));
  }
  return `${lines.join('\n')}\n`;
}

async function runProbe(resultPath) {
  const probePath = fileURLToPath(new URL('./loadProbe.mjs', import.meta.url));
  const child = spawn(process.execPath, [probePath, String(ROOMS), String(SECONDS)], {
    env: { ...process.env, WOBBLE_LOAD_RESULT_PATH: resultPath },
    stdio: 'inherit'
  });
  const code = await new Promise((resolveChild, reject) => {
    child.once('error', reject);
    child.once('exit', resolveChild);
  });
  if (code !== 0) throw new Error(`load probe exited with status ${code}`);
}

async function main() {
  const budgets = loadBudgetConfig();
  const tempDir = await mkdtemp(join(tmpdir(), 'wobble-load-gate-'));
  const resultPath = EXTERNAL_RESULT_PATH || join(tempDir, 'result.json');
  try {
    await runProbe(resultPath);
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    const evaluation = evaluateLoadResult(result, budgets);
    const enriched = { ...result, gate: evaluation };
    const summary = markdownSummary(result, evaluation);

    if (EXTERNAL_RESULT_PATH) {
      await writeFile(EXTERNAL_RESULT_PATH, `${JSON.stringify(enriched, null, 2)}\n`, 'utf8');
    }
    if (SUMMARY_PATH) await writeFile(SUMMARY_PATH, summary, 'utf8');

    console.log('\n--- SERVER LOAD GATE ---');
    console.log(summary.trim());
    if (!evaluation.ok) process.exitCode = 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) await main();
