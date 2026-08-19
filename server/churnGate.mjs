// Assertion layer for deterministic reconnect/churn stress.
//
// churnProbe.mjs owns traffic generation. This file owns policy, machine-readable gate output and
// Markdown diagnostics so future churn scenarios can evolve without duplicating CI assertions.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULT_PATH = String(process.env.WOBBLE_CHURN_RESULT_PATH || '').trim() || null;
const SUMMARY_PATH = String(process.env.WOBBLE_CHURN_SUMMARY_PATH || '').trim() || null;

function optionalPositiveNumber(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive finite number, got ${JSON.stringify(value)}`);
  }
  return number;
}

function ratio(value, label, fallback = 1) {
  const raw = value === undefined || value === null || String(value).trim() === '' ? fallback : Number(value);
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new Error(`${label} must be between 0 and 1, got ${JSON.stringify(value)}`);
  }
  return raw;
}

export function churnBudgets(env = process.env) {
  return {
    baselineEventLoopP95Ms: optionalPositiveNumber(
      env.WOBBLE_CHURN_BASELINE_EVENT_LOOP_P95_MS,
      'WOBBLE_CHURN_BASELINE_EVENT_LOOP_P95_MS'
    ),
    maxEventLoopP95Ms: optionalPositiveNumber(
      env.WOBBLE_CHURN_MAX_EVENT_LOOP_P95_MS,
      'WOBBLE_CHURN_MAX_EVENT_LOOP_P95_MS'
    ),
    baselineRssMb: optionalPositiveNumber(env.WOBBLE_CHURN_BASELINE_RSS_MB, 'WOBBLE_CHURN_BASELINE_RSS_MB'),
    maxRssMb: optionalPositiveNumber(env.WOBBLE_CHURN_MAX_RSS_MB, 'WOBBLE_CHURN_MAX_RSS_MB'),
    minResumeSuccessRate: ratio(
      env.WOBBLE_CHURN_MIN_RESUME_SUCCESS_RATE,
      'WOBBLE_CHURN_MIN_RESUME_SUCCESS_RATE',
      1
    )
  };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function pushZeroDelta(result, failures, name, label = name) {
  const value = result?.deltas?.[name];
  if (!finite(value)) failures.push(`${label} delta is missing or non-finite`);
  else if (value !== 0) failures.push(`${label} delta ${value} != 0`);
}

function checkFinalBaseline(result, failures) {
  const baseline = result?.baseline || {};
  const final = result?.final || {};
  for (const name of ['rooms', 'players', 'sessions']) {
    if (!integer(baseline[name])) failures.push(`baseline ${name} is missing or invalid`);
    if (!integer(final[name])) failures.push(`final ${name} is missing or invalid`);
    if (integer(baseline[name]) && integer(final[name]) && final[name] !== baseline[name]) {
      failures.push(`final ${name} ${final[name]} != baseline ${baseline[name]}`);
    }
  }
}

export function evaluateChurnResult(result, budgets = churnBudgets({})) {
  const failures = [];
  const warnings = [];
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      failures: ['churn probe did not produce a machine-readable result'],
      warnings,
      budgets
    };
  }

  if (Array.isArray(result.failures)) failures.push(...result.failures.map(item => `probe: ${item}`));

  const config = result.config || {};
  const scenarios = result.scenarios || {};
  const baseline = result.baseline || {};
  const peaks = result.peaks || {};
  const attempts = result.resumeAttempts;
  const succeeded = result.resumeSucceededObserved;

  if (!integer(attempts) || attempts < 1) failures.push('resume attempts are missing or zero');
  if (!integer(succeeded)) failures.push('observed resume successes are missing or invalid');
  if (integer(attempts) && integer(succeeded) && succeeded !== attempts) {
    failures.push(`observed resume successes ${succeeded} != attempts ${attempts}`);
  }
  if (!finite(result.resumeSuccessRate)) failures.push('resume success rate is missing or non-finite');
  else if (result.resumeSuccessRate < budgets.minResumeSuccessRate) {
    failures.push(
      `resume success rate ${(result.resumeSuccessRate * 100).toFixed(1)}% < minimum ${(budgets.minResumeSuccessRate * 100).toFixed(1)}%`
    );
  }

  const serverResumeSucceeded = result?.deltas?.resumeSucceeded;
  if (!finite(serverResumeSucceeded)) failures.push('resumeSucceeded delta is missing or non-finite');
  else if (integer(attempts) && serverResumeSucceeded !== attempts) {
    failures.push(`resumeSucceeded delta ${serverResumeSucceeded} != expected ${attempts}`);
  }
  pushZeroDelta(result, failures, 'resumeFailed');
  pushZeroDelta(result, failures, 'handlerErrors');
  pushZeroDelta(result, failures, 'socketSendFailures');
  pushZeroDelta(result, failures, 'invalidMessages');
  pushZeroDelta(result, failures, 'capacityRejected');
  pushZeroDelta(result, failures, 'snapshotsSkippedForLoad');
  pushZeroDelta(result, failures, 'verificationFailed');
  pushZeroDelta(result, failures, 'latePacketsDropped');

  if (result.identityMismatches !== 0) failures.push(`identity mismatches ${result.identityMismatches} != 0`);
  if (result.duplicatePlayerObservations !== 0) {
    failures.push(`duplicate player observations ${result.duplicatePlayerObservations} != 0`);
  }
  if (result.roomCountMismatches !== 0) {
    failures.push(`room/player/session count mismatches ${result.roomCountMismatches} != 0`);
  }

  const stale = scenarios.staleSocket || {};
  if (!integer(stale.cases) || stale.cases < 1) failures.push('stale old-socket scenario did not run');
  if (!integer(stale.passed) || stale.passed !== stale.cases) {
    failures.push(`stale old-socket cases passed ${stale.passed ?? 'missing'}/${stale.cases ?? 'missing'}`);
  }

  const storm = scenarios.storm || {};
  if (!integer(storm.clients) || storm.clients < 20 || storm.clients > 40) {
    failures.push(`reconnect storm client count ${storm.clients ?? 'missing'} is outside 20..40`);
  }
  if (!integer(storm.succeeded) || storm.succeeded !== storm.clients) {
    failures.push(`reconnect storm successes ${storm.succeeded ?? 'missing'}/${storm.clients ?? 'missing'}`);
  }
  if (storm.readiness?.ok !== true || storm.readiness?.status !== 200) {
    failures.push(`server not ready after reconnect storm (HTTP ${storm.readiness?.status ?? 'unknown'})`);
  }

  const roomChurn = scenarios.roomChurn || {};
  if (!integer(roomChurn.iterations) || roomChurn.iterations < 100) {
    failures.push(`room churn iterations ${roomChurn.iterations ?? 'missing'} < 100`);
  }
  if (!integer(roomChurn.reclaimed) || roomChurn.reclaimed !== roomChurn.iterations) {
    failures.push(`rooms reclaimed ${roomChurn.reclaimed ?? 'missing'}/${roomChurn.iterations ?? 'missing'}`);
  }

  checkFinalBaseline(result, failures);
  if (result.readiness?.ok !== true || result.readiness?.status !== 200) {
    failures.push(`server not ready after churn cleanup (HTTP ${result.readiness?.status ?? 'unknown'})`);
  }

  const roomCeiling = Number(baseline.rooms) + Number(config.baseRooms);
  const playerCeiling = Number(baseline.players) + Number(config.baseClients);
  const sessionCeiling = Number(baseline.sessions) + Number(config.baseClients);
  if (!finite(peaks.peakRooms)) failures.push('peak rooms is missing or non-finite');
  else if (finite(roomCeiling) && peaks.peakRooms > roomCeiling) {
    failures.push(`peak rooms ${peaks.peakRooms} > expected bound ${roomCeiling}`);
  }
  if (!finite(peaks.peakPlayers)) failures.push('peak players is missing or non-finite');
  else if (finite(playerCeiling) && peaks.peakPlayers > playerCeiling) {
    failures.push(`peak players ${peaks.peakPlayers} > expected bound ${playerCeiling}`);
  }
  if (!finite(peaks.peakSessions)) failures.push('peak sessions is missing or non-finite');
  else if (finite(sessionCeiling) && peaks.peakSessions > sessionCeiling) {
    failures.push(`peak sessions ${peaks.peakSessions} > expected bound ${sessionCeiling}`);
  }

  if (!finite(peaks.peakEventLoopP95Ms)) failures.push('peak event-loop p95 is missing or non-finite');
  else if (budgets.maxEventLoopP95Ms !== null && peaks.peakEventLoopP95Ms > budgets.maxEventLoopP95Ms) {
    failures.push(
      `event-loop p95 ${peaks.peakEventLoopP95Ms} ms > hard budget ${budgets.maxEventLoopP95Ms} ms`
    );
  }
  if (!finite(peaks.peakRssMb)) failures.push('peak RSS is missing or non-finite');
  else if (budgets.maxRssMb !== null && peaks.peakRssMb > budgets.maxRssMb) {
    failures.push(`RSS ${peaks.peakRssMb} MB > hard budget ${budgets.maxRssMb} MB`);
  }

  return { ok: failures.length === 0, failures, warnings, budgets };
}

function metricWithReference(value, reference, unit) {
  if (!finite(value)) return '—';
  if (!finite(reference)) return `${value}${unit}`;
  const delta = Math.round((value - reference) * 10) / 10;
  return `${value}${unit} (ref ${reference}${unit}, Δ ${delta >= 0 ? '+' : ''}${delta}${unit})`;
}

export function churnMarkdownSummary(result, gate) {
  const scenarios = result?.scenarios || {};
  const peaks = result?.peaks || {};
  const baseline = result?.baseline || {};
  const final = result?.final || {};
  const lines = [
    '### Server reconnect / churn stress',
    '',
    `**Result:** ${gate.ok ? 'PASS' : 'FAIL'}`,
    '',
    '| Scenario | Result |',
    '| --- | --- |',
    `| Rapid disconnect/resume | ${scenarios.rapid?.succeeded ?? '—'} / ${scenarios.rapid?.attempts ?? '—'} resumes |`,
    `| Stale old-socket close | ${scenarios.staleSocket?.passed ?? '—'} / ${scenarios.staleSocket?.cases ?? '—'} cases |`,
    `| Reconnect storm | ${scenarios.storm?.succeeded ?? '—'} / ${scenarios.storm?.clients ?? '—'} clients |`,
    `| Room churn | ${scenarios.roomChurn?.reclaimed ?? '—'} / ${scenarios.roomChurn?.iterations ?? '—'} rooms reclaimed |`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Resume success rate | ${finite(result?.resumeSuccessRate) ? `${(result.resumeSuccessRate * 100).toFixed(1)}%` : '—'} |`,
    `| Server resumeSucceeded Δ | ${result?.deltas?.resumeSucceeded ?? '—'} |`,
    `| Server resumeFailed Δ | ${result?.deltas?.resumeFailed ?? '—'} |`,
    `| Peak event-loop p95 | ${metricWithReference(peaks.peakEventLoopP95Ms, gate.budgets.baselineEventLoopP95Ms, ' ms')} |`,
    `| Peak RSS | ${metricWithReference(peaks.peakRssMb, gate.budgets.baselineRssMb, ' MB')} |`,
    `| Peak sessions | ${peaks.peakSessions ?? '—'} |`,
    `| Cleanup rooms | ${final.rooms ?? '—'} (baseline ${baseline.rooms ?? '—'}) |`,
    `| Cleanup players | ${final.players ?? '—'} (baseline ${baseline.players ?? '—'}) |`,
    `| Cleanup sessions | ${final.sessions ?? '—'} (baseline ${baseline.sessions ?? '—'}) |`,
    `| Ready after cleanup | ${result?.readiness?.ok ? 'yes' : `no (HTTP ${result?.readiness?.status ?? 'unknown'})`} |`,
    '',
    '| Error delta | Value |',
    '| --- | ---: |',
    `| handlerErrors | ${result?.deltas?.handlerErrors ?? '—'} |`,
    `| socketSendFailures | ${result?.deltas?.socketSendFailures ?? '—'} |`,
    `| invalidMessages | ${result?.deltas?.invalidMessages ?? '—'} |`,
    `| capacityRejected | ${result?.deltas?.capacityRejected ?? '—'} |`,
    `| verificationFailed | ${result?.deltas?.verificationFailed ?? '—'} |`,
    `| latePacketsDropped | ${result?.deltas?.latePacketsDropped ?? '—'} |`,
    `| snapshotsSkippedForLoad | ${result?.deltas?.snapshotsSkippedForLoad ?? '—'} |`
  ];
  if (gate.failures.length) {
    lines.push('', '**Failures:**', ...gate.failures.map(failure => `- ${failure}`));
  }
  return `${lines.join('\n')}\n`;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function runProbe(tempDir) {
  const probeResultPath = join(tempDir, 'churn-probe.json');
  const probePath = fileURLToPath(new URL('./churnProbe.mjs', import.meta.url));
  const child = spawn(process.execPath, [probePath], {
    env: { ...process.env, WOBBLE_CHURN_PROBE_RESULT_PATH: probeResultPath },
    stdio: 'inherit'
  });
  const exitCode = await new Promise((resolveChild, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolveChild(code ?? 1));
  });
  return { exitCode, result: await readJson(probeResultPath) };
}

async function main() {
  const budgets = churnBudgets();
  const tempDir = await mkdtemp(join(tmpdir(), 'wobble-churn-gate-'));
  try {
    const { exitCode, result } = await runProbe(tempDir);
    const gate = evaluateChurnResult(result, budgets);
    if (exitCode !== 0 && !gate.failures.some(failure => failure.startsWith('probe:'))) {
      gate.failures.unshift(`churn probe exited with status ${exitCode}`);
      gate.ok = false;
    }
    const aggregate = { ...(result || {}), gate };
    const summary = churnMarkdownSummary(result, gate);

    if (RESULT_PATH) await writeFile(RESULT_PATH, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
    if (SUMMARY_PATH) await writeFile(SUMMARY_PATH, summary, 'utf8');

    console.log('\n--- RECONNECT / CHURN GATE ---');
    console.log(summary.trim());
    if (!gate.ok) process.exitCode = 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) await main();
