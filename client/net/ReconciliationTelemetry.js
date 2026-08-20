export const RECONCILIATION_TELEMETRY_SAMPLE_LIMIT = 256;

function positiveLimit(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : RECONCILIATION_TELEMETRY_SAMPLE_LIMIT;
}

function percentile95(samples) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export class RollingReconciliationErrorStats {
  constructor(limit = RECONCILIATION_TELEMETRY_SAMPLE_LIMIT) {
    this.limit = positiveLimit(limit);
    this.reset();
  }

  reset() {
    this.count = 0;
    this.sum = 0;
    this.max = 0;
    this.samples = [];
  }

  record(value) {
    if (!Number.isFinite(value) || value < 0) return false;
    this.count += 1;
    this.sum += value;
    this.max = Math.max(this.max, value);
    this.samples.push(value);
    if (this.samples.length > this.limit) this.samples.shift();
    return true;
  }

  snapshot() {
    return {
      count: this.count,
      mean: this.count ? this.sum / this.count : 0,
      p95: percentile95(this.samples),
      max: this.max,
      recentSamples: this.samples.length
    };
  }
}

function validError(error) {
  return (
    !!error &&
    Number.isFinite(error.positionError) &&
    Number.isFinite(error.horizontalPositionError) &&
    Number.isFinite(error.verticalPositionError) &&
    Number.isFinite(error.velocityError) &&
    typeof error.groundedMismatch === 'boolean'
  );
}

export class ReconciliationTelemetry {
  constructor({ sampleLimit = RECONCILIATION_TELEMETRY_SAMPLE_LIMIT } = {}) {
    this.sampleLimit = positiveLimit(sampleLimit);
    this.positionError = new RollingReconciliationErrorStats(this.sampleLimit);
    this.horizontalPositionError = new RollingReconciliationErrorStats(this.sampleLimit);
    this.verticalPositionError = new RollingReconciliationErrorStats(this.sampleLimit);
    this.velocityError = new RollingReconciliationErrorStats(this.sampleLimit);
    this.reset();
  }

  reset(matchId = null) {
    this.matchId = matchId;
    this.lastServerTick = -1;
    this.replayAttempts = 0;
    this.historyGaps = 0;
    this.localComparisons = 0;
    this.groundedMismatches = 0;
    this.positionError.reset();
    this.horizontalPositionError.reset();
    this.verticalPositionError.reset();
    this.velocityError.reset();
  }

  record({ serverTick, historyGap = false, error = null }) {
    if (!Number.isSafeInteger(serverTick) || serverTick < 0 || serverTick <= this.lastServerTick) {
      return false;
    }
    this.lastServerTick = serverTick;
    this.replayAttempts += 1;
    if (historyGap) this.historyGaps += 1;

    if (validError(error)) {
      this.localComparisons += 1;
      if (error.groundedMismatch) this.groundedMismatches += 1;
      this.positionError.record(error.positionError);
      this.horizontalPositionError.record(error.horizontalPositionError);
      this.verticalPositionError.record(error.verticalPositionError);
      this.velocityError.record(error.velocityError);
    }
    return true;
  }

  snapshot() {
    return {
      matchId: this.matchId,
      lastServerTick: this.lastServerTick,
      replayAttempts: this.replayAttempts,
      historyGaps: this.historyGaps,
      historyGapRate: this.replayAttempts ? this.historyGaps / this.replayAttempts : 0,
      localComparisons: this.localComparisons,
      groundedMismatches: this.groundedMismatches,
      groundedMismatchRate: this.localComparisons ? this.groundedMismatches / this.localComparisons : 0,
      positionError: this.positionError.snapshot(),
      horizontalPositionError: this.horizontalPositionError.snapshot(),
      verticalPositionError: this.verticalPositionError.snapshot(),
      velocityError: this.velocityError.snapshot()
    };
  }
}
