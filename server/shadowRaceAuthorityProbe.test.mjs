import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AUTHORITY_SOURCE, FALLBACK_REASON } = require('./raceProgressAuthoritySelector');
const { PROBE_ENV, createShadowRaceAuthorityProbe, probeSource } = require('./shadowRaceAuthorityProbe');

const player = () => ({ checkpoint: 2, finished: false });
const availableSample = () => ({
  available: true,
  shadowCheckpoint: 3,
  shadowFinished: true
});
const ready = () => ({ ready: true, reasons: [] });

test('probe source defaults safely to legacy', () => {
  assert.equal(PROBE_ENV, 'SHADOW_RACE_AUTHORITY_PROBE');
  assert.equal(probeSource(undefined), AUTHORITY_SOURCE.LEGACY);
  assert.equal(probeSource('legacy'), AUTHORITY_SOURCE.LEGACY);
  assert.equal(probeSource('SHADOW'), AUTHORITY_SOURCE.LEGACY);
  assert.equal(probeSource('shadow'), AUTHORITY_SOURCE.SHADOW);
});

test('legacy probe never selects a healthy shadow candidate', () => {
  const probe = createShadowRaceAuthorityProbe({ requestedSource: AUTHORITY_SOURCE.LEGACY });
  const result = probe.observe({ sample: availableSample(), player: player(), readiness: ready() });
  const metrics = probe.metrics();

  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(metrics.decisions, 1);
  assert.equal(metrics.requestedLegacy, 1);
  assert.equal(metrics.selectedLegacy, 1);
  assert.equal(metrics.selectedShadow, 0);
});

test('shadow probe selects shadow only after readiness is clean', () => {
  const probe = createShadowRaceAuthorityProbe({ requestedSource: AUTHORITY_SOURCE.SHADOW });
  const result = probe.observe({ sample: availableSample(), player: player(), readiness: ready() });
  const metrics = probe.metrics();

  assert.equal(result.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(metrics.requestedShadow, 1);
  assert.equal(metrics.selectedShadow, 1);
  assert.equal(metrics.fallbackShadowNotReady, 0);
});

test('shadow probe records readiness fallback without changing legacy input', () => {
  const legacy = player();
  const probe = createShadowRaceAuthorityProbe({ requestedSource: AUTHORITY_SOURCE.SHADOW });
  const result = probe.observe({
    sample: availableSample(),
    player: legacy,
    readiness: { ready: false, reasons: ['checkpoint-mismatch'] }
  });
  const metrics = probe.metrics();

  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(result.fallbackReason, FALLBACK_REASON.SHADOW_NOT_READY);
  assert.equal(metrics.fallbackShadowNotReady, 1);
  assert.deepEqual(legacy, player());
});

test('unavailable candidate is counted only after readiness allows shadow', () => {
  const probe = createShadowRaceAuthorityProbe({ requestedSource: AUTHORITY_SOURCE.SHADOW });
  const result = probe.observe({
    sample: { available: false, reason: 'candidate-unavailable' },
    player: player(),
    readiness: ready()
  });
  const metrics = probe.metrics();

  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(result.fallbackReason, FALLBACK_REASON.SHADOW_UNAVAILABLE);
  assert.equal(metrics.fallbackShadowUnavailable, 1);
});

test('invalid legacy progress fails closed and is counted', () => {
  const probe = createShadowRaceAuthorityProbe({ requestedSource: AUTHORITY_SOURCE.SHADOW });
  const result = probe.observe({
    sample: availableSample(),
    player: { checkpoint: -1, finished: false },
    readiness: ready()
  });
  const metrics = probe.metrics();

  assert.equal(result.ok, false);
  assert.equal(result.fallbackReason, FALLBACK_REASON.INVALID_LEGACY);
  assert.equal(metrics.fallbackInvalidLegacy, 1);
});

test('missing boundary sample is ignored and reset clears counters', () => {
  const probe = createShadowRaceAuthorityProbe({ requestedSource: AUTHORITY_SOURCE.SHADOW });
  assert.equal(probe.observe({ player: player(), readiness: ready() }), null);
  assert.equal(probe.metrics().decisions, 0);

  probe.observe({ sample: availableSample(), player: player(), readiness: ready() });
  assert.equal(probe.metrics().decisions, 1);
  probe.reset();
  assert.equal(probe.metrics().decisions, 0);
  assert.equal(Object.isFrozen(probe.metrics()), true);
});
