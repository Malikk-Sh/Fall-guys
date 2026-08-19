// Automated reliability gate around loadProbe.mjs.
//
// The generator remains useful on its own. This wrapper adds deterministic assertions for CI and
// writes a compact Markdown summary. The first gate intentionally does NOT invent a new hard RSS or
// event-loop p95 budget: those values are recorded as a baseline, while /health/ready continues to
// enforce the server's existing overload threshold.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOMS = Math.max(1, Number(process.argv[2] || 24));
const SECONDS = Math.max(1, Number(process.argv[3] || 12));
const SUMMARY_PATH = String(process.env.WOBBLE_LOAD_SUMMARY_PATH || '').trim() || null;
const EXTERNAL_RESULT_PATH = String(process.env.WOBBLE_LOAD_RESULT_PATH || '').trim() || null;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function evaluateLoadResult(result) {
  const failures = [];
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
  if (!finiteNumber(after.load?.eventLoopP95Ms)) failures.push('event-loop p95 metric is missing');
  if (!finiteNumber(after.load?.rssMb)) failures.push('RSS metric is missing');

  return { ok: failures.length === 0, failures };
}

function markdownSummary(result, evaluation) {
  const after = result.after || {};
  const deltas = result.deltas || {};
  const rows = [
    ['Rooms', `${after.rooms ?? '—'} (${result.roomsRequested} requested)`],
    ['Players', `${after.players ?? '—'} (${result.playersRequested} requested)`],
    ['Duration', `${result.seconds}s`],
    ['Ready after load', result.readiness?.ok ? 'yes' : `no (HTTP ${result.readiness?.status ?? '—'})`],
    ['Event-loop p95', `${after.load?.eventLoopP95Ms ?? '—'} ms`],
    ['RSS', `${after.load?.rssMb ?? '—'} MB`],
    ['Invalid messages Δ', `${deltas.invalidMessages ?? '—'}`],
    ['Socket send failures Δ', `${deltas.socketSendFailures ?? '—'}`],
    ['Handler errors Δ', `${deltas.handlerErrors ?? '—'}`],
    ['Capacity rejections Δ', `${deltas.capacityRejected ?? '—'}`],
    ['Snapshots skipped for load Δ', `${deltas.snapshotsSkippedForLoad ?? '—'}`]
  ];
  const lines = [
    '### Server WebSocket load gate',
    '',
    `**Result:** ${evaluation.ok ? 'PASS' : 'FAIL'}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
    '',
    '> Event-loop p95 and RSS are baseline telemetry in this first gate. No new hard budget is applied yet; readiness still uses the server’s existing overload threshold.'
  ];

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
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new Error(`load probe exited with status ${code}`);
}

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), 'wobble-load-gate-'));
  const resultPath = EXTERNAL_RESULT_PATH || join(tempDir, 'result.json');
  try {
    await runProbe(resultPath);
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    const evaluation = evaluateLoadResult(result);
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

await main();
