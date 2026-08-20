import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  AUTHORITY_SOURCE,
  FALLBACK_REASON,
  readinessAllowsShadow,
  selectRaceProgressAuthority,
  validProgress
} = require('./raceProgressAuthoritySelector');

const legacyProgress = () => ({ checkpoint: 2, finished: false });
const shadowProgress = () => ({ checkpoint: 3, finished: true, serverTick: 91 });
const ready = () => ({ ready: true, reasons: [] });

test('legacy remains the default authority source', () => {
  const result = selectRaceProgressAuthority({
    legacy: legacyProgress(),
    shadow: shadowProgress(),
    readiness: ready()
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(result.fallbackReason, null);
  assert.deepEqual(result.progress, legacyProgress());
});

test('shadow is selected only when explicitly requested and ready', () => {
  const result = selectRaceProgressAuthority({
    requestedSource: AUTHORITY_SOURCE.SHADOW,
    legacy: legacyProgress(),
    shadow: shadowProgress(),
    readiness: ready()
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(result.fallbackReason, null);
  assert.deepEqual(result.progress, { checkpoint: 3, finished: true });
});

test('unready shadow request falls back to legacy', () => {
  const result = selectRaceProgressAuthority({
    requestedSource: AUTHORITY_SOURCE.SHADOW,
    legacy: legacyProgress(),
    shadow: shadowProgress(),
    readiness: { ready: false, reasons: ['checkpoint-mismatch'] }
  });

  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(result.fallbackReason, FALLBACK_REASON.SHADOW_NOT_READY);
  assert.deepEqual(result.progress, legacyProgress());
});

test('missing shadow candidate falls back to legacy', () => {
  const result = selectRaceProgressAuthority({
    requestedSource: AUTHORITY_SOURCE.SHADOW,
    legacy: legacyProgress(),
    readiness: ready()
  });

  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(result.fallbackReason, FALLBACK_REASON.SHADOW_UNAVAILABLE);
});

test('malformed readiness never enables shadow', () => {
  assert.equal(readinessAllowsShadow({ ready: true }), false);
  assert.equal(readinessAllowsShadow({ ready: true, reasons: ['blocked'] }), false);
  assert.equal(readinessAllowsShadow(ready()), true);
});

test('invalid legacy progress fails closed before considering shadow', () => {
  const result = selectRaceProgressAuthority({
    requestedSource: AUTHORITY_SOURCE.SHADOW,
    legacy: { checkpoint: -1, finished: false },
    shadow: shadowProgress(),
    readiness: ready()
  });

  assert.equal(result.ok, false);
  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(result.fallbackReason, FALLBACK_REASON.INVALID_LEGACY);
  assert.equal(result.progress, null);
});

test('selection snapshots are immutable and do not leak extra candidate fields', () => {
  const legacy = legacyProgress();
  const shadow = shadowProgress();
  const result = selectRaceProgressAuthority({
    requestedSource: AUTHORITY_SOURCE.SHADOW,
    legacy,
    shadow,
    readiness: ready()
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.progress), true);
  assert.deepEqual(result.progress, { checkpoint: 3, finished: true });
  assert.equal(Object.hasOwn(result.progress, 'serverTick'), false);
  assert.deepEqual(legacy, legacyProgress());
  assert.deepEqual(shadow, shadowProgress());
  assert.equal(validProgress(result.progress), true);
});
