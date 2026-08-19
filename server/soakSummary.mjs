// Weekly soak/endurance assertion and Markdown summary policy.
//
// The probe owns workload generation and raw time-series capture. This file owns correctness,
// performance budgets and leak/degradation diagnostics so pure gate logic stays unit-testable.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CRITICAL_ZERO_DELTAS = Object.freeze([
  'handlerErrors',
  'socketSendFailures',
  'invalidMessages',
  'capacityRejected',
  'resumeFailed',
  'verificationFailed',
  'latePacketsDropped',
  'snapshotsSkippedForLoad'
]);

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new Error(`${label} must be a finite number, got ${JSON.stringify(value)}`);
  return number;
}

function positiveNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) throw new Error(`${label} must be > 0, got ${number}`);
  return number;
}

function nonNegativeNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number < 0) throw new Error(`${label} must be >= 0, got ${number}`);
  return number;
}

function boolEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(value || '')
      .trim()
      .toLowerCase()
  );
}

export function soakBudgetsFromEnv(env = process.env) {
  return {
    maxEventLoopP95Ms: positiveNumber(
      env.WOBBLE_SOAK_MAX_EVENT_LOOP_P95_MS ?? 60,
      'WOBBLE_SOAK_MAX_EVENT_LOOP_P95_MS'
    ),
    maxRssMb: positiveNumber(env.WOBBLE_SOAK_MAX_RSS_MB ?? 180, 'WOBBLE_SOAK_MAX_RSS_MB'),
    warnRecoveryRssGrowthMb: nonNegativeNumber(
      env.WOBBLE_SOAK_WARN_RECOVERY_RSS_GROWTH_MB ?? 32,
      'WOBBLE_SOAK_WARN_RECOVERY_RSS_GROWTH_MB'
    ),
    maxRecoveryRssGrowthMb: positiveNumber(
      env.WOBBLE_SOAK_MAX_RECOVERY_RSS_GROWTH_MB ?? 64,
      'WOBBLE_SOAK_MAX_RECOVERY_RSS_GROWTH_MB'
    ),
    warnRecoveryHeapGrowthMb: nonNegativeNumber(
      env.WOBBLE_SOAK_WARN_RECOVERY_HEAP_GROWTH_MB ?? 24,
      'WOBBLE_SOAK_WARN_RECOVERY_HEAP_GROWTH_MB'
    ),
    maxRecoveryHeapGrowthMb: positiveNumber(
      env.WOBBLE_SOAK_MAX_RECOVERY_HEAP_GROWTH_MB ?? 48,
      'WOBBLE_SOAK_MAX_RECOVERY_HEAP_GROWTH_MB'
    ),
    minDurationSeconds: positiveNumber(
      env.WOBBLE_SOAK_MIN_DURATION_SECONDS ?? 1800,
      'WOBBLE_SOAK_MIN_DURATION_SECONDS'
    ),
    allowShortRun: boolEnv(env.WOBBLE_SOAK_ALLOW_SHORT)
  };
}

function median(values) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function phaseSamples(probe, phaseName) {
  return (probe.samples || []).filter(sample => sample.phaseName === phaseName);
}

function lastHalfMedian(samples, field) {
  if (!samples.length) return null;
  const start = Math.floor(samples.length / 2);
  return median(samples.slice(start).map(sample => sample[field]));
}

function trend(samples, field) {
  const values = samples.map(sample => Number(sample[field])).filter(Number.isFinite);
  if (values.length < 3) {
    return {
      firstMedian: values.length ? median(values) : null,
      lastMedian: values.length ? median(values) : null,
      growthMb: values.length > 1 ? values.at(-1) - values[0] : 0,
      nonDecreasingRatio: null
    };
  }
  const bucket = Math.max(1, Math.floor(values.length / 3));
  const firstMedian = median(values.slice(0, bucket));
  const lastMedian = median(values.slice(-bucket));
  let nonDecreasing = 0;
  for (let index = 1; index < values.length; index++) {
    if (values[index] >= values[index - 1]) nonDecreasing += 1;
  }
  return {
    firstMedian,
    lastMedian,
    growthMb: lastMedian - firstMedian,
    nonDecreasingRatio: nonDecreasing / (values.length - 1)
  };
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

function phasePeak(probe, phaseName, field) {
  const values = phaseSamples(probe, phaseName)
    .map(sample => Number(sample[field]))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

export function evaluateSoak(probe, budgets = soakBudgetsFromEnv({})) {
  const failures = [...(Array.isArray(probe?.failures) ? probe.failures : [])];
  const warnings = [];
  const samples = Array.isArray(probe?.samples) ? probe.samples : [];
  const phases = Array.isArray(probe?.phases) ? probe.phases : [];

  if (!samples.length) failures.push('missing soak time-series samples');
  if (!phases.length) failures.push('missing soak phase results');

  const plannedDurationSeconds = Number(probe?.config?.plannedDurationSeconds);
  if (!Number.isFinite(plannedDurationSeconds)) {
    failures.push('missing planned soak duration');
  } else if (!budgets.allowShortRun && plannedDurationSeconds < budgets.minDurationSeconds) {
    failures.push(
      `planned soak duration ${plannedDurationSeconds}s < minimum ${budgets.minDurationSeconds}s`
    );
  }

  for (const phase of phases) {
    if (phase.status !== 'PASS') failures.push(`phase ${phase.name || phase.index} did not pass`);
  }

  const baseline = counts(probe?.baseline);
  const final = counts(probe?.final);
  if (!Object.values(baseline).every(Number.isFinite))
    failures.push('missing baseline room/player/session counts');
  if (!Object.values(final).every(Number.isFinite)) failures.push('missing final room/player/session counts');
  if (
    Object.values(baseline).every(Number.isFinite) &&
    Object.values(final).every(Number.isFinite) &&
    !sameCounts(final, baseline)
  ) {
    failures.push(`cleanup counts ${JSON.stringify(final)} != baseline ${JSON.stringify(baseline)}`);
  }

  if (probe?.readiness?.ok !== true || Number(probe?.readiness?.status) !== 200) {
    failures.push(`readiness after soak is not healthy (HTTP ${probe?.readiness?.status ?? 'unknown'})`);
  }

  const deltas = probe?.deltas || {};
  for (const name of CRITICAL_ZERO_DELTAS) {
    const value = Number(deltas[name]);
    if (!Number.isFinite(value)) failures.push(`missing metric delta ${name}`);
    else if (value !== 0) failures.push(`${name} delta ${value}`);
  }

  const churnPulses = Array.isArray(probe?.churnPulses) ? probe.churnPulses : [];
  const failedPulses = churnPulses.filter(pulse => pulse.status !== 'PASS');
  if (failedPulses.length) failures.push(`${failedPulses.length} churn pulse(s) failed`);
  if (churnPulses.length && Number(deltas.resumeSucceeded) <= 0) {
    failures.push('churn pulses ran but resumeSucceeded did not increase');
  }

  const eventLoopValues = samples.map(sample => Number(sample.eventLoopP95Ms)).filter(Number.isFinite);
  const rssValues = samples.map(sample => Number(sample.rssMb)).filter(Number.isFinite);
  const heapValues = samples.map(sample => Number(sample.heapUsedMb)).filter(Number.isFinite);
  if (eventLoopValues.length !== samples.length)
    failures.push('one or more samples are missing event-loop p95');
  if (rssValues.length !== samples.length) failures.push('one or more samples are missing RSS');
  if (heapValues.length !== samples.length) failures.push('one or more samples are missing heap used');

  const peakEventLoopP95Ms = eventLoopValues.length ? Math.max(...eventLoopValues) : null;
  const peakRssMb = rssValues.length ? Math.max(...rssValues) : null;
  const peakHeapUsedMb = heapValues.length ? Math.max(...heapValues) : null;
  if (peakEventLoopP95Ms !== null && peakEventLoopP95Ms > budgets.maxEventLoopP95Ms) {
    failures.push(`event-loop p95 peak ${peakEventLoopP95Ms} ms > budget ${budgets.maxEventLoopP95Ms} ms`);
  }
  if (peakRssMb !== null && peakRssMb > budgets.maxRssMb) {
    failures.push(`RSS peak ${peakRssMb} MB > budget ${budgets.maxRssMb} MB`);
  }
  if (samples.some(sample => sample.overloaded === true))
    failures.push('server reported overloaded during soak');

  const initialRssMb = rssValues.length ? rssValues[0] : null;
  const endRssMb = rssValues.length ? rssValues.at(-1) : null;
  const initialHeapUsedMb = heapValues.length ? heapValues[0] : null;
  const endHeapUsedMb = heapValues.length ? heapValues.at(-1) : null;
  const base24RssMb = lastHalfMedian(phaseSamples(probe, 'base-24'), 'rssMb');
  const recovery24RssMb = lastHalfMedian(phaseSamples(probe, 'recovery-24'), 'rssMb');
  const base24HeapUsedMb = lastHalfMedian(phaseSamples(probe, 'base-24'), 'heapUsedMb');
  const recovery24HeapUsedMb = lastHalfMedian(phaseSamples(probe, 'recovery-24'), 'heapUsedMb');
  const recoverySamples = phaseSamples(probe, 'recovery-24');
  const recoveryRssTrend = trend(recoverySamples, 'rssMb');
  const recoveryHeapTrend = trend(recoverySamples, 'heapUsedMb');

  const strongMonotonic = value => value !== null && value >= 0.8;
  if (
    recoveryRssTrend.growthMb > budgets.maxRecoveryRssGrowthMb &&
    strongMonotonic(recoveryRssTrend.nonDecreasingRatio)
  ) {
    failures.push(
      `recovery RSS grew ${recoveryRssTrend.growthMb.toFixed(1)} MB with ` +
        `${(recoveryRssTrend.nonDecreasingRatio * 100).toFixed(0)}% non-decreasing samples`
    );
  } else if (
    recoveryRssTrend.growthMb > budgets.warnRecoveryRssGrowthMb &&
    strongMonotonic(recoveryRssTrend.nonDecreasingRatio)
  ) {
    warnings.push(
      `recovery RSS trend +${recoveryRssTrend.growthMb.toFixed(1)} MB ` +
        `(${(recoveryRssTrend.nonDecreasingRatio * 100).toFixed(0)}% non-decreasing)`
    );
  }

  if (
    recoveryHeapTrend.growthMb > budgets.maxRecoveryHeapGrowthMb &&
    strongMonotonic(recoveryHeapTrend.nonDecreasingRatio)
  ) {
    failures.push(
      `recovery heap grew ${recoveryHeapTrend.growthMb.toFixed(1)} MB with ` +
        `${(recoveryHeapTrend.nonDecreasingRatio * 100).toFixed(0)}% non-decreasing samples`
    );
  } else if (
    recoveryHeapTrend.growthMb > budgets.warnRecoveryHeapGrowthMb &&
    strongMonotonic(recoveryHeapTrend.nonDecreasingRatio)
  ) {
    warnings.push(
      `recovery heap trend +${recoveryHeapTrend.growthMb.toFixed(1)} MB ` +
        `(${(recoveryHeapTrend.nonDecreasingRatio * 100).toFixed(0)}% non-decreasing)`
    );
  }

  const phaseMetrics = phases.map(phase => ({
    index: phase.index,
    name: phase.name,
    rooms: phase.rooms,
    churn: Boolean(phase.churn),
    sampleCount: phaseSamples(probe, phase.name).length,
    peakEventLoopP95Ms: phasePeak(probe, phase.name, 'eventLoopP95Ms'),
    peakRssMb: phasePeak(probe, phase.name, 'rssMb'),
    peakHeapUsedMb: phasePeak(probe, phase.name, 'heapUsedMb'),
    churnPulses: churnPulses.filter(pulse => pulse.phaseName === phase.name).length,
    status: phase.status
  }));

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    budgets,
    metrics: {
      plannedDurationSeconds,
      actualDurationSeconds: Number(probe?.durationSeconds),
      sampleCount: samples.length,
      peakEventLoopP95Ms,
      peakRssMb,
      peakHeapUsedMb,
      initialRssMb,
      endRssMb,
      initialHeapUsedMb,
      endHeapUsedMb,
      base24RssMb,
      recovery24RssMb,
      base24HeapUsedMb,
      recovery24HeapUsedMb,
      recoveryRssTrend,
      recoveryHeapTrend,
      phaseMetrics,
      churnPulseCount: churnPulses.length,
      resumeSucceededDelta: Number(deltas.resumeSucceeded)
    }
  };
}

function fmt(value, suffix = '') {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1).replace(/\.0$/, '')}${suffix}` : '—';
}

export function renderSoakSummary(probe, gate) {
  const result = gate.ok ? (gate.warnings.length ? 'PASS with warnings' : 'PASS') : 'FAIL';
  const lines = [
    '### Weekly Multiplayer Soak',
    '',
    `**Result:** ${result}`,
    '',
    `**Planned duration:** ${fmt(gate.metrics.plannedDurationSeconds, 's')} · **samples:** ${gate.metrics.sampleCount}`,
    '',
    '| Phase | Rooms | Churn | Samples | p95 peak | RSS peak | Heap peak | Churn pulses | Result |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for (const phase of gate.metrics.phaseMetrics) {
    lines.push(
      `| ${phase.name} | ${phase.rooms} | ${phase.churn ? 'yes' : 'no'} | ${phase.sampleCount} | ` +
        `${fmt(phase.peakEventLoopP95Ms, ' ms')} | ${fmt(phase.peakRssMb, ' MB')} | ` +
        `${fmt(phase.peakHeapUsedMb, ' MB')} | ${phase.churnPulses} | ${phase.status} |`
    );
  }

  lines.push(
    '',
    '#### Memory / recovery',
    '',
    '| Metric | Start / base | Peak | Recovery / end | Budget / diagnostic |',
    '| --- | ---: | ---: | ---: | --- |',
    `| RSS | ${fmt(gate.metrics.base24RssMb ?? gate.metrics.initialRssMb, ' MB')} | ` +
      `${fmt(gate.metrics.peakRssMb, ' MB')} | ${fmt(gate.metrics.recovery24RssMb ?? gate.metrics.endRssMb, ' MB')} | ` +
      `hard peak ${gate.budgets.maxRssMb} MB |`,
    `| Heap used | ${fmt(gate.metrics.base24HeapUsedMb ?? gate.metrics.initialHeapUsedMb, ' MB')} | ` +
      `${fmt(gate.metrics.peakHeapUsedMb, ' MB')} | ` +
      `${fmt(gate.metrics.recovery24HeapUsedMb ?? gate.metrics.endHeapUsedMb, ' MB')} | recovery trend monitored |`,
    `| Event-loop p95 | — | ${fmt(gate.metrics.peakEventLoopP95Ms, ' ms')} | — | hard ${gate.budgets.maxEventLoopP95Ms} ms |`,
    '',
    `Recovery RSS trend: ${fmt(gate.metrics.recoveryRssTrend.growthMb, ' MB')} · ` +
      `recovery heap trend: ${fmt(gate.metrics.recoveryHeapTrend.growthMb, ' MB')}`,
    '',
    `Churn pulses: ${gate.metrics.churnPulseCount} · resumeSucceeded Δ ${gate.metrics.resumeSucceededDelta}`,
    ''
  );

  if (gate.warnings.length) {
    lines.push('#### Warnings', '', ...gate.warnings.map(item => `- WARN: ${item}`), '');
  }
  if (gate.failures.length) {
    lines.push('#### Failures', '', ...gate.failures.map(item => `- FAIL: ${item}`), '');
  }

  lines.push(
    '> RSS is not required to return exactly to its start value. The weekly gate checks bounded hard ' +
      'budgets plus recovery-phase trend, while JSON/CSV telemetry preserves the raw time series for review.',
    ''
  );
  return lines.join('\n');
}

async function main() {
  const probePath = String(process.env.WOBBLE_SOAK_PROBE_RESULT_PATH || '').trim();
  if (!probePath) throw new Error('WOBBLE_SOAK_PROBE_RESULT_PATH is required');
  const probe = JSON.parse(await readFile(probePath, 'utf8'));
  const gate = evaluateSoak(probe, soakBudgetsFromEnv(process.env));
  const summary = renderSoakSummary(probe, gate);

  const resultPath = String(process.env.WOBBLE_SOAK_RESULT_PATH || '').trim();
  const summaryPath = String(process.env.WOBBLE_SOAK_SUMMARY_PATH || '').trim();
  if (resultPath) await writeFile(resultPath, `${JSON.stringify(gate, null, 2)}\n`, 'utf8');
  if (summaryPath) await writeFile(summaryPath, `${summary}\n`, 'utf8');

  console.log(summary);
  if (!gate.ok) process.exitCode = 1;
}

const mainUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (mainUrl === import.meta.url) {
  main().catch(error => {
    console.error(`SOAK SUMMARY FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
