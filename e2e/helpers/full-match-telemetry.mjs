const percentile = (sorted, ratio) => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
};

export function summarizeIntervals(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0, median: null, p95: null, max: null, average: null };
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
    average: sum / sorted.length
  };
}

export function createPollTelemetry(startedAt = Date.now()) {
  return {
    startedAt,
    lastPollAt: null,
    intervals: [],
    iterations: 0,
    maxAbsX: 0,
    maxAbsVx: 0
  };
}

export function recordPoll(telemetry, status, polledAt = Date.now()) {
  if (telemetry.lastPollAt !== null) telemetry.intervals.push(polledAt - telemetry.lastPollAt);
  telemetry.lastPollAt = polledAt;
  telemetry.iterations++;
  telemetry.maxAbsX = Math.max(telemetry.maxAbsX, Math.abs(status.x || 0));
  telemetry.maxAbsVx = Math.max(telemetry.maxAbsVx, Math.abs(status.vx || 0));
}

export function summarizePollTelemetry(telemetry) {
  return {
    iterations: telemetry.iterations,
    intervals: summarizeIntervals(telemetry.intervals),
    maxAbsX: telemetry.maxAbsX,
    maxAbsVx: telemetry.maxAbsVx
  };
}

export async function installFrameProbe(page) {
  await page.evaluate(() => {
    if (window.__WOBBLE_E2E_FRAME_PROBE__) return;
    const probe = { last: null, intervals: [] };
    window.__WOBBLE_E2E_FRAME_PROBE__ = probe;
    const tick = now => {
      if (probe.last !== null) {
        probe.intervals.push(now - probe.last);
        if (probe.intervals.length > 600) probe.intervals.shift();
      }
      probe.last = now;
      window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
}

export async function readFrameTelemetry(page) {
  const values = await page.evaluate(() => window.__WOBBLE_E2E_FRAME_PROBE__?.intervals?.slice() || []);
  const intervals = summarizeIntervals(values);
  return {
    intervals,
    estimatedFps: intervals.median ? 1000 / intervals.median : null
  };
}

const number = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

export function describeRuntimeTelemetry(telemetry) {
  if (!telemetry) return 'timing —';
  const control = telemetry.control || telemetry.poll || {};
  const controlIntervals = control.intervals || {};
  const controlLabel = telemetry.control ? 'control' : 'poll';
  const frame = telemetry.frame?.intervals || {};
  return (
    `${controlLabel} итераций ${control.iterations ?? 0}, median ${number(controlIntervals.median)}мс, ` +
    `p95 ${number(controlIntervals.p95)}мс, max ${number(controlIntervals.max)}мс; ` +
    `rAF ~${number(telemetry.frame?.estimatedFps, 1)} FPS, median ${number(frame.median, 1)}мс, ` +
    `p95 ${number(frame.p95, 1)}мс, max ${number(frame.max, 1)}мс; ` +
    `max |x| ${number(control.maxAbsX, 2)}, max |vx| ${number(control.maxAbsVx, 2)}`
  );
}
