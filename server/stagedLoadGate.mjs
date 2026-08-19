// Sequential WebSocket reliability stages around the existing loadGate.mjs.
//
// The gameplay server is intentionally started outside this process and stays alive across all
// stages. Each stage reuses the production-path load gate, so room/player/error assertions and
// performance budgets have one source of truth. The next stage starts only after the previous one
// passes.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_STAGE_SPEC = '24:12,48:12,96:12';

const SUMMARY_PATH = String(process.env.WOBBLE_STAGED_LOAD_SUMMARY_PATH || '').trim() || null;
const RESULT_PATH = String(process.env.WOBBLE_STAGED_LOAD_RESULT_PATH || '').trim() || null;

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return number;
}

export function parseStages(spec = DEFAULT_STAGE_SPEC) {
  const raw = String(spec || '').trim();
  if (!raw) throw new Error('WOBBLE_LOAD_STAGES must contain at least one stage');

  return raw.split(',').map((entry, index) => {
    const parts = entry.trim().split(':');
    if (parts.length !== 2) {
      throw new Error(`stage ${index + 1} must use rooms:seconds syntax, got ${JSON.stringify(entry)}`);
    }
    const rooms = positiveInteger(parts[0], `stage ${index + 1} rooms`);
    const seconds = positiveInteger(parts[1], `stage ${index + 1} seconds`);
    return { rooms, clients: rooms * 2, seconds };
  });
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function displayMetric(value, unit = '') {
  if (!finiteNumber(value)) return '—';
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit ? `${formatted} ${unit}` : formatted;
}

export function stageRecord(stageNumber, stage, result, exitCode) {
  const gate = result?.gate || {};
  const after = result?.after || {};
  const deltas = result?.deltas || {};
  const failures = Array.isArray(gate.failures) ? [...gate.failures] : [];
  const warnings = Array.isArray(gate.warnings) ? [...gate.warnings] : [];

  if (!result) failures.push('stage did not produce a machine-readable load result');
  if (exitCode !== 0 && failures.length === 0) {
    failures.push(`load gate exited with status ${exitCode}`);
  }
  if (exitCode === 0 && gate.ok !== true) {
    failures.push('load gate exited successfully without a PASS gate evaluation');
  }

  const ok = exitCode === 0 && gate.ok === true && failures.length === 0;
  return {
    stage: stageNumber,
    rooms: stage.rooms,
    clients: stage.clients,
    seconds: stage.seconds,
    status: ok ? 'PASS' : 'FAIL',
    eventLoopP95Ms: after.load?.eventLoopP95Ms ?? null,
    rssMb: after.load?.rssMb ?? null,
    sessions: after.sessions ?? null,
    snapshotsSkippedForLoad: deltas.snapshotsSkippedForLoad ?? null,
    invalidMessages: deltas.invalidMessages ?? null,
    socketSendFailures: deltas.socketSendFailures ?? null,
    handlerErrors: deltas.handlerErrors ?? null,
    capacityRejected: deltas.capacityRejected ?? null,
    verificationFailed: deltas.verificationFailed ?? null,
    latePacketsDropped: deltas.latePacketsDropped ?? null,
    readiness: result?.readiness ?? null,
    budgets: gate.budgets || {},
    warnings,
    failures
  };
}

function stageLabel(stage) {
  return `${stage.rooms} rooms / ${stage.clients} clients / ${stage.seconds}s`;
}

export function stagedMarkdownSummary(records, stages) {
  const complete = records.length === stages.length && records.every(record => record.status === 'PASS');
  const firstFailure = records.find(record => record.status === 'FAIL') || null;
  const warnings = records.flatMap(record =>
    record.warnings.map(warning => `Stage ${record.stage}: ${warning}`)
  );
  const resultLabel = complete ? (warnings.length ? `PASS (${warnings.length} warning)` : 'PASS') : 'FAIL';
  const lines = [
    '### Server WebSocket staged load',
    '',
    `**Result:** ${resultLabel}`,
    '',
    `**Plan:** ${stages.map(stageLabel).join(' → ')}`,
    '',
    '> One gameplay server process stays alive across the sequence. Each stage must pass before the next stage starts.',
    '',
    '| Stage | Rooms | Clients | p95 | RSS | Snapshot skips Δ | Result |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...records.map(record =>
      [
        `| ${record.stage}`,
        record.rooms,
        record.clients,
        displayMetric(record.eventLoopP95Ms, 'ms'),
        displayMetric(record.rssMb, 'MB'),
        displayMetric(record.snapshotsSkippedForLoad),
        `${record.status} |`
      ].join(' | ')
    ),
    '',
    '#### Per-stage diagnostics',
    '',
    '| Stage | Sessions | Invalid Δ | Send failures Δ | Handler errors Δ | Capacity rejected Δ | Verification failed Δ | Late packets Δ | Ready |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...records.map(record =>
      [
        `| ${record.stage}`,
        displayMetric(record.sessions),
        displayMetric(record.invalidMessages),
        displayMetric(record.socketSendFailures),
        displayMetric(record.handlerErrors),
        displayMetric(record.capacityRejected),
        displayMetric(record.verificationFailed),
        displayMetric(record.latePacketsDropped),
        record.readiness?.ok ? 'yes' : `no (${record.readiness?.status ?? 'unknown'}) |`
      ].join(' | ')
    )
  ];

  if (warnings.length) {
    lines.push('', '**Warnings:**', ...warnings.map(warning => `- ${warning}`));
  }
  if (firstFailure) {
    lines.push(
      '',
      `**Stopped after Stage ${firstFailure.stage}.** Later stages were not started.`,
      '',
      '**Failures:**',
      ...firstFailure.failures.map(failure => `- Stage ${firstFailure.stage}: ${failure}`)
    );
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

async function runStage(stage, stageNumber, tempDir) {
  const resultPath = join(tempDir, `stage-${stageNumber}.json`);
  const summaryPath = join(tempDir, `stage-${stageNumber}.md`);
  const gatePath = fileURLToPath(new URL('./loadGate.mjs', import.meta.url));
  const child = spawn(process.execPath, [gatePath, String(stage.rooms), String(stage.seconds)], {
    env: {
      ...process.env,
      WOBBLE_LOAD_RESULT_PATH: resultPath,
      WOBBLE_LOAD_SUMMARY_PATH: summaryPath
    },
    stdio: 'inherit'
  });
  const exitCode = await new Promise((resolveChild, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolveChild(code ?? 1));
  });
  return stageRecord(stageNumber, stage, await readJson(resultPath), exitCode);
}

async function main() {
  const stages = parseStages(process.env.WOBBLE_LOAD_STAGES || DEFAULT_STAGE_SPEC);
  const tempDir = await mkdtemp(join(tmpdir(), 'wobble-staged-load-'));
  const records = [];

  try {
    for (let index = 0; index < stages.length; index++) {
      const stage = stages[index];
      const stageNumber = index + 1;
      console.log(`\n=== STAGED LOAD ${stageNumber}/${stages.length}: ${stageLabel(stage)} ===`);
      const record = await runStage(stage, stageNumber, tempDir);
      records.push(record);
      if (record.status !== 'PASS') break;
    }

    const complete = records.length === stages.length && records.every(record => record.status === 'PASS');
    const summary = stagedMarkdownSummary(records, stages);
    const aggregate = {
      ok: complete,
      stagesRequested: stages,
      stagesRun: records,
      stoppedAfterStage: complete ? null : (records.at(-1)?.stage ?? null)
    };

    if (RESULT_PATH) await writeFile(RESULT_PATH, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8');
    if (SUMMARY_PATH) await writeFile(SUMMARY_PATH, summary, 'utf8');

    console.log('\n--- STAGED SERVER LOAD GATE ---');
    console.log(summary.trim());
    if (!complete) process.exitCode = 1;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) await main();
