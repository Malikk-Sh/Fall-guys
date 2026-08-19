// Weekly Multiplayer Soak workload generator and raw time-series recorder.
//
// Keeps one gameplay server alive outside this process, drives the existing real-WebSocket load
// and reconnect/churn generators through changing 5-minute phases, and samples /health throughout.
// Assertion policy belongs to soakSummary.mjs.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { loadTargets } from './loadProbeConfig.mjs';

const { wsUrl, httpUrl } = loadTargets();
const PROBE_RESULT_PATH = String(process.env.WOBBLE_SOAK_PROBE_RESULT_PATH || '').trim() || null;
const CSV_PATH = String(process.env.WOBBLE_SOAK_CSV_PATH || '').trim() || null;
const PHASE_SECONDS = positiveInteger(
  process.env.WOBBLE_SOAK_PHASE_SECONDS || 300,
  'WOBBLE_SOAK_PHASE_SECONDS'
);
const SAMPLE_MS = boundedInteger(
  process.env.WOBBLE_SOAK_SAMPLE_MS || 20000,
  'WOBBLE_SOAK_SAMPLE_MS',
  1000,
  60000
);
const CHURN_PULSE_MS = boundedInteger(
  process.env.WOBBLE_SOAK_CHURN_PULSE_MS || 60000,
  'WOBBLE_SOAK_CHURN_PULSE_MS',
  3000,
  300000
);
const CHURN_ROOMS = boundedInteger(
  process.env.WOBBLE_SOAK_CHURN_ROOMS || 10,
  'WOBBLE_SOAK_CHURN_ROOMS',
  10,
  20
);
const CHURN_STORM_CLIENTS = boundedInteger(
  process.env.WOBBLE_SOAK_CHURN_STORM_CLIENTS || 20,
  'WOBBLE_SOAK_CHURN_STORM_CLIENTS',
  20,
  40
);
const CHURN_ROOM_ITERATIONS = positiveInteger(
  process.env.WOBBLE_SOAK_CHURN_ROOM_ITERATIONS || 20,
  'WOBBLE_SOAK_CHURN_ROOM_ITERATIONS'
);

if (CHURN_STORM_CLIENTS > CHURN_ROOMS * 2) {
  throw new Error(
    `WOBBLE_SOAK_CHURN_STORM_CLIENTS ${CHURN_STORM_CLIENTS} exceed churn clients ${CHURN_ROOMS * 2}`
  );
}

const PROFILE = Object.freeze([
  { index: 1, name: 'base-24', rooms: 24, churn: false },
  { index: 2, name: 'base-48', rooms: 48, churn: false },
  { index: 3, name: 'load-24-churn', rooms: 24, churn: true },
  { index: 4, name: 'load-48-churn', rooms: 48, churn: true },
  { index: 5, name: 'burst-96', rooms: 96, churn: false },
  { index: 6, name: 'recovery-24', rooms: 24, churn: false }
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return number;
}

function boundedInteger(value, label, min, max) {
  const number = positiveInteger(value, label);
  if (number < min || number > max) throw new Error(`${label} must be in ${min}..${max}, got ${number}`);
  return number;
}

async function health() {
  const response = await fetch(`${httpUrl}/health`);
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  return response.json();
}

async function readiness() {
  const response = await fetch(`${httpUrl}/health/ready`);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // HTTP status remains useful when an intermediary returns a non-JSON body.
  }
  return { ok: response.ok && body?.ok === true, status: response.status };
}

function counts(value = {}) {
  return {
    rooms: Number(value.rooms),
    players: Number(value.players),
    sessions: Number(value.sessions)
  };
}

function sameCounts(actual, expected) {
  return ['rooms', 'players', 'sessions'].every(name => actual[name] === expected[name]);
}

async function waitForCounts(expected, ms = 10000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() <= deadline) {
    last = await health();
    if (sameCounts(counts(last), expected)) return last;
    await sleep(50);
  }
  throw new Error(
    `cleanup counts ${JSON.stringify(counts(last || {}))} did not return to ${JSON.stringify(expected)}`
  );
}

function metricDelta(before, after, name) {
  return Number(after.metrics?.[name] || 0) - Number(before.metrics?.[name] || 0);
}

function compactHealth(value) {
  return {
    rooms: Number(value.rooms),
    players: Number(value.players),
    sessions: Number(value.sessions),
    activeSockets: Number(value.capacity?.socketCount),
    activeMatches: Number(value.capacity?.activeMatches),
    eventLoopP95Ms: Number(value.load?.eventLoopP95Ms),
    rssMb: Number(value.load?.rssMb),
    heapUsedMb: Number(value.load?.heapUsedMb),
    overloaded: value.load?.overloaded === true,
    metrics: value.metrics || {}
  };
}

function tail(text, max = 2500) {
  const value = String(text || '');
  return value.length <= max ? value : value.slice(-max);
}

function spawnNode(args, { env = {}, label }) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.length > 200000) stdout = stdout.slice(-200000);
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    if (stderr.length > 200000) stderr = stderr.slice(-200000);
  });
  const done = new Promise(resolve => {
    child.once('close', (code, signal) => {
      resolve({
        label,
        code: Number.isInteger(code) ? code : 1,
        signal: signal || null,
        stdout,
        stderr
      });
    });
    child.once('error', error => {
      resolve({
        label,
        code: 1,
        signal: null,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`
      });
    });
  });
  return { child, done };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvFromSamples(samples) {
  const columns = [
    'at',
    'elapsedSeconds',
    'phaseIndex',
    'phaseName',
    'phaseRooms',
    'phaseChurn',
    'rooms',
    'players',
    'sessions',
    'activeSockets',
    'activeMatches',
    'eventLoopP95Ms',
    'rssMb',
    'heapUsedMb',
    'overloaded',
    'handlerErrors',
    'socketSendFailures',
    'invalidMessages',
    'capacityRejected',
    'resumeSucceeded',
    'resumeFailed',
    'snapshotsSkippedForLoad'
  ];
  const rows = [columns.join(',')];
  for (const sample of samples) {
    const flat = {
      ...sample,
      handlerErrors: sample.metrics?.handlerErrors,
      socketSendFailures: sample.metrics?.socketSendFailures,
      invalidMessages: sample.metrics?.invalidMessages,
      capacityRejected: sample.metrics?.capacityRejected,
      resumeSucceeded: sample.metrics?.resumeSucceeded,
      resumeFailed: sample.metrics?.resumeFailed,
      snapshotsSkippedForLoad: sample.metrics?.snapshotsSkippedForLoad
    };
    rows.push(columns.map(column => csvEscape(flat[column])).join(','));
  }
  return `${rows.join('\n')}\n`;
}

const startedAtMs = Date.now();
const initial = await health();
const baseline = counts(initial);
const workDir = join(tmpdir(), `wobble-soak-${process.pid}`);
await mkdir(workDir, { recursive: true });

const result = {
  version: 1,
  startedAt: new Date(startedAtMs).toISOString(),
  config: {
    phaseSeconds: PHASE_SECONDS,
    plannedDurationSeconds: PHASE_SECONDS * PROFILE.length,
    sampleMs: SAMPLE_MS,
    churnPulseMs: CHURN_PULSE_MS,
    churnRooms: CHURN_ROOMS,
    churnStormClients: CHURN_STORM_CLIENTS,
    churnRoomIterations: CHURN_ROOM_ITERATIONS,
    profile: PROFILE
  },
  targets: { wsUrl, httpUrl },
  baseline,
  phases: [],
  churnPulses: [],
  samples: [],
  failures: []
};

let currentPhase = { index: 0, name: 'initial', rooms: 0, churn: false };
let sampling = false;
let sampleTimer = null;

async function captureSample(reason) {
  const value = await health();
  const compact = compactHealth(value);
  result.samples.push({
    at: new Date().toISOString(),
    elapsedSeconds: Number(((Date.now() - startedAtMs) / 1000).toFixed(1)),
    reason,
    phaseIndex: currentPhase.index,
    phaseName: currentPhase.name,
    phaseRooms: currentPhase.rooms,
    phaseChurn: currentPhase.churn,
    ...compact
  });
  return value;
}

function startSampling() {
  sampleTimer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      await captureSample('interval');
    } catch (error) {
      const message = `time-series sample failed: ${error instanceof Error ? error.message : String(error)}`;
      if (!result.failures.includes(message)) result.failures.push(message);
    } finally {
      sampling = false;
    }
  }, SAMPLE_MS);
}

async function stopSampling() {
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = null;
  while (sampling) await sleep(10);
}

let pulseCounter = 0;

async function runChurnPulse(phase) {
  pulseCounter += 1;
  const pulseId = pulseCounter;
  const pulseResultPath = join(workDir, `churn-${pulseId}.json`);
  const child = spawnNode(['server/churnProbe.mjs'], {
    label: `churn pulse ${pulseId}`,
    env: {
      WOBBLE_WS_URL: wsUrl,
      WOBBLE_HTTP_URL: httpUrl,
      WOBBLE_CHURN_ROOMS: String(CHURN_ROOMS),
      WOBBLE_CHURN_RAPID_CYCLES: '1',
      WOBBLE_CHURN_STORM_CLIENTS: String(CHURN_STORM_CLIENTS),
      WOBBLE_CHURN_ROOM_ITERATIONS: String(CHURN_ROOM_ITERATIONS),
      WOBBLE_CHURN_PROBE_RESULT_PATH: pulseResultPath
    }
  });
  const outcome = await child.done;
  let parsed = null;
  try {
    parsed = await readJson(pulseResultPath);
  } catch {
    // Failure output below is more useful when the child could not write its JSON.
  }

  const pulseFailures = [];
  if (outcome.code !== 0) pulseFailures.push(`process exit ${outcome.code}`);
  if (!parsed) {
    pulseFailures.push('missing machine-readable churn result');
  } else {
    if (Array.isArray(parsed.failures) && parsed.failures.length) pulseFailures.push(...parsed.failures);
    if (parsed.resumeAttempts !== parsed.resumeSucceededObserved) {
      pulseFailures.push(
        `resume successes ${parsed.resumeSucceededObserved ?? 'missing'} != attempts ${parsed.resumeAttempts ?? 'missing'}`
      );
    }
    if (parsed.scenarios?.roomChurn?.reclaimed !== parsed.scenarios?.roomChurn?.iterations) {
      pulseFailures.push(
        `rooms reclaimed ${parsed.scenarios?.roomChurn?.reclaimed ?? 'missing'}/` +
          `${parsed.scenarios?.roomChurn?.iterations ?? 'missing'}`
      );
    }
    if (parsed.readiness?.ok !== true || Number(parsed.readiness?.status) !== 200) {
      pulseFailures.push(`readiness HTTP ${parsed.readiness?.status ?? 'unknown'}`);
    }
    for (const name of [
      'handlerErrors',
      'socketSendFailures',
      'invalidMessages',
      'capacityRejected',
      'resumeFailed',
      'verificationFailed',
      'latePacketsDropped',
      'snapshotsSkippedForLoad'
    ]) {
      if (Number(parsed.deltas?.[name]) !== 0) {
        pulseFailures.push(`${name} delta ${parsed.deltas?.[name] ?? 'missing'}`);
      }
    }
  }

  const pulse = {
    index: pulseId,
    phaseIndex: phase.index,
    phaseName: phase.name,
    status: pulseFailures.length ? 'FAIL' : 'PASS',
    code: outcome.code,
    resumeAttempts: parsed?.resumeAttempts,
    resumeSucceededObserved: parsed?.resumeSucceededObserved,
    peakEventLoopP95Ms: parsed?.peaks?.peakEventLoopP95Ms,
    peakRssMb: parsed?.peaks?.peakRssMb,
    failures: pulseFailures
  };
  result.churnPulses.push(pulse);

  if (pulseFailures.length) {
    throw new Error(
      `${outcome.label} failed: ${pulseFailures.join('; ')}${tail(outcome.stderr || outcome.stdout) ? ` · ${tail(outcome.stderr || outcome.stdout)}` : ''}`
    );
  }
  console.log(
    `churn pulse ${pulseId} PASS in ${phase.name}` +
      (pulse.resumeSucceededObserved ? ` · resumes ${pulse.resumeSucceededObserved}` : '')
  );
}

async function runChurnPulses(phase, loadState) {
  const phaseMs = PHASE_SECONDS * 1000;
  const firstDelay = Math.max(1000, Math.min(30000, Math.floor(CHURN_PULSE_MS / 2), Math.floor(phaseMs / 4)));
  const guardMs = Math.max(3000, Math.min(45000, Math.floor(phaseMs / 4)));
  const phaseStarted = Date.now();
  let nextAt = phaseStarted + firstDelay;
  let ran = 0;

  while (!loadState.done) {
    const waitMs = nextAt - Date.now();
    if (waitMs > 0) await sleep(Math.min(waitMs, 1000));
    if (Date.now() < nextAt) continue;
    const remaining = phaseStarted + phaseMs - Date.now();
    if (remaining < guardMs && ran > 0) break;
    await runChurnPulse(phase);
    ran += 1;
    nextAt += CHURN_PULSE_MS;
  }

  if (!ran && !loadState.done) {
    await runChurnPulse(phase);
    ran = 1;
  }
  return ran;
}

async function runPhase(phase) {
  currentPhase = phase;
  console.log(
    `\n=== SOAK PHASE ${phase.index}/${PROFILE.length}: ${phase.name} · ${phase.rooms} rooms` +
      `${phase.churn ? ' + churn' : ''} · ${PHASE_SECONDS}s ===`
  );
  await captureSample('phase-start');

  const loadResultPath = join(workDir, `load-${phase.index}.json`);
  const loadSummaryPath = join(workDir, `load-${phase.index}.md`);
  const load = spawnNode(['server/loadGate.mjs', String(phase.rooms), String(PHASE_SECONDS)], {
    label: `load phase ${phase.name}`,
    env: {
      WOBBLE_WS_URL: wsUrl,
      WOBBLE_HTTP_URL: httpUrl,
      WOBBLE_LOAD_RESULT_PATH: loadResultPath,
      WOBBLE_LOAD_SUMMARY_PATH: loadSummaryPath,
      WOBBLE_LOAD_BASELINE_EVENT_LOOP_P95_MS: process.env.WOBBLE_SOAK_BASELINE_EVENT_LOOP_P95_MS || '20.9',
      WOBBLE_LOAD_WARN_EVENT_LOOP_P95_MS: process.env.WOBBLE_SOAK_WARN_EVENT_LOOP_P95_MS || '45',
      WOBBLE_LOAD_MAX_EVENT_LOOP_P95_MS: process.env.WOBBLE_SOAK_MAX_EVENT_LOOP_P95_MS || '60',
      WOBBLE_LOAD_BASELINE_RSS_MB: process.env.WOBBLE_SOAK_BASELINE_RSS_MB || '108',
      WOBBLE_LOAD_MAX_RSS_MB: process.env.WOBBLE_SOAK_MAX_RSS_MB || '180'
    }
  });
  const loadState = { done: false };
  load.done.then(() => {
    loadState.done = true;
  });

  let pulseFailure = null;
  const pulses = phase.churn
    ? runChurnPulses(phase, loadState).catch(error => {
        pulseFailure = error;
        return 0;
      })
    : Promise.resolve(0);

  const loadOutcome = await load.done;
  const pulseCount = await pulses;
  let loadResult = null;
  try {
    loadResult = await readJson(loadResultPath);
  } catch {
    // A failed child may not have produced machine-readable output.
  }

  const phaseResult = {
    ...phase,
    seconds: PHASE_SECONDS,
    status: 'PASS',
    loadExitCode: loadOutcome.code,
    churnPulses: pulseCount,
    loadResult: loadResult
      ? {
          after: loadResult.after,
          readiness: loadResult.readiness,
          deltas: loadResult.deltas
        }
      : null
  };

  if (loadOutcome.code !== 0) {
    phaseResult.status = 'FAIL';
    result.failures.push(
      `${loadOutcome.label} failed with code ${loadOutcome.code}: ${tail(loadOutcome.stderr || loadOutcome.stdout)}`
    );
  } else if (!loadResult || loadResult.gate?.ok !== true) {
    phaseResult.status = 'FAIL';
    result.failures.push(`${phase.name}: load gate result missing or not ok`);
  }
  if (pulseFailure) {
    phaseResult.status = 'FAIL';
    result.failures.push(pulseFailure instanceof Error ? pulseFailure.message : String(pulseFailure));
  }
  if (phase.churn && pulseCount < 1) {
    phaseResult.status = 'FAIL';
    result.failures.push(`${phase.name}: no reconnect/churn pulse completed`);
  }

  try {
    await waitForCounts(baseline);
  } catch (error) {
    phaseResult.status = 'FAIL';
    result.failures.push(`${phase.name}: ${error instanceof Error ? error.message : String(error)}`);
  }

  await captureSample('phase-cleanup');
  result.phases.push(phaseResult);
  console.log(`${phase.name}: ${phaseResult.status}`);

  if (phaseResult.status !== 'PASS') throw new Error(`phase ${phase.name} failed`);
}

console.log(`target ws:   ${wsUrl}`);
console.log(`target http: ${httpUrl}`);
console.log(
  `weekly soak: ${PROFILE.map(phase => `${phase.rooms}${phase.churn ? '+churn' : ''}`).join(' → ')} rooms · ` +
    `${PHASE_SECONDS}s/phase · samples every ${SAMPLE_MS}ms`
);

try {
  await captureSample('initial');
  startSampling();
  for (const phase of PROFILE) await runPhase(phase);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!result.failures.includes(message)) result.failures.push(message);
  console.error(`SOAK PROBE FAIL: ${message}`);
} finally {
  await stopSampling();

  try {
    const finalHealth = await waitForCounts(baseline);
    currentPhase = { index: 7, name: 'final', rooms: 0, churn: false };
    const finalCompact = compactHealth(finalHealth);
    result.final = finalCompact;
    result.readiness = await readiness();
    result.deltas = Object.fromEntries(
      [
        'handlerErrors',
        'socketSendFailures',
        'invalidMessages',
        'capacityRejected',
        'resumeSucceeded',
        'resumeFailed',
        'verificationFailed',
        'latePacketsDropped',
        'snapshotsSkippedForLoad'
      ].map(name => [name, metricDelta(initial, finalHealth, name)])
    );
    await captureSample('final');
  } catch (error) {
    result.failures.push(`final cleanup: ${error instanceof Error ? error.message : String(error)}`);
  }

  result.endedAt = new Date().toISOString();
  result.durationSeconds = Number(((Date.now() - startedAtMs) / 1000).toFixed(1));

  if (PROBE_RESULT_PATH) {
    await writeFile(PROBE_RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  if (CSV_PATH) await writeFile(CSV_PATH, csvFromSamples(result.samples), 'utf8');

  console.log('\n--- WEEKLY SOAK PROBE ---');
  console.log(`planned duration:      ${result.config.plannedDurationSeconds}s`);
  console.log(`actual duration:       ${result.durationSeconds}s`);
  console.log(`time-series samples:   ${result.samples.length}`);
  console.log(`churn pulses:          ${result.churnPulses.length}`);
  console.log(`final counts:          ${JSON.stringify(counts(result.final || {}))}`);
  console.log(`ready after cleanup:   ${result.readiness?.ok ? 'yes' : 'no'}`);
  for (const failure of result.failures) console.error(`FAIL: ${failure}`);

  if (result.failures.length) process.exitCode = 1;
}
