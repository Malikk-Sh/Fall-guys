import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_MOVEMENT_PARITY_POLICY,
  REASON,
  createMovementParityProvider,
  evaluateMovementParity
} = require('./shadowMovementParityEvidence');

// Измерение, которое политика обязана принять: выборок достаточно, опора сходится, отрыв мал.
function goodMetrics(overrides = {}) {
  return {
    samples: 5000,
    agreements: 5000,
    groundedMismatch: 0,
    shadowGroundedOnly: 0,
    clientGroundedOnly: 0,
    worldMissing: 0,
    impulses: 200,
    wallBounces: 12,
    heightError: { count: 5000, mean: 0.004, p95: 0.01, max: 0.03 },
    freeTrajectoryError: { count: 5000, mean: 0.08, p95: 0.2, max: 0.5 },
    ...overrides
  };
}

test('без измерения доказательств нет', () => {
  for (const metrics of [null, undefined, {}, { samples: 'много' }]) {
    const evaluation = evaluateMovementParity(metrics);
    assert.equal(evaluation.collisionParityVerified, false);
    assert.equal(evaluation.obstacleParityVerified, false);
    assert.deepEqual(evaluation.reasons, [REASON.INVALID_METRICS]);
  }
});

test('пустое измерение отказывает по нехватке выборок, а не проходит', () => {
  const evaluation = evaluateMovementParity(
    goodMetrics({
      samples: 0,
      agreements: 0,
      impulses: 0,
      heightError: { count: 0, mean: 0, p95: 0, max: 0 }
    })
  );
  assert.equal(evaluation.collisionParityVerified, false);
  assert.ok(evaluation.reasons.includes(REASON.INSUFFICIENT_SAMPLES));
  assert.ok(evaluation.reasons.includes(REASON.GROUND_AGREEMENT), 'нулевое согласие не «нейтрально»');
});

test('достаточное и сходящееся измерение подтверждает оба признака', () => {
  const evaluation = evaluateMovementParity(goodMetrics());
  assert.equal(evaluation.collisionParityVerified, true);
  assert.equal(evaluation.obstacleParityVerified, true);
  assert.deepEqual(evaluation.reasons, []);
});

test('сервер, дающий пол там, где клиент падает, запрещён полностью', () => {
  const evaluation = evaluateMovementParity(goodMetrics({ shadowGroundedOnly: 1, agreements: 4999 }));
  assert.equal(evaluation.collisionParityVerified, false);
  assert.ok(evaluation.reasons.includes(REASON.SHADOW_GROUNDED_ONLY));
});

test('расхождение по высоте стояния закрывает ворота', () => {
  const byMean = evaluateMovementParity(
    goodMetrics({ heightError: { count: 5000, mean: 0.5, p95: 0.6, max: 0.7 } })
  );
  assert.equal(byMean.collisionParityVerified, false);
  assert.ok(byMean.reasons.includes(REASON.GROUND_HEIGHT_ERROR));

  const byMax = evaluateMovementParity(
    goodMetrics({ heightError: { count: 5000, mean: 0.001, p95: 0.002, max: 5 } })
  );
  assert.equal(byMax.collisionParityVerified, false);
});

test('слишком большой отрыв траектории закрывает ворота', () => {
  const evaluation = evaluateMovementParity(
    goodMetrics({ freeTrajectoryError: { count: 5000, mean: 2, p95: 4, max: 9 } })
  );
  assert.equal(evaluation.collisionParityVerified, false);
  assert.ok(evaluation.reasons.includes(REASON.TRAJECTORY_ERROR));
});

test('матч без построенной геометрии доказательством быть не может', () => {
  const evaluation = evaluateMovementParity(goodMetrics({ worldMissing: 1 }));
  assert.equal(evaluation.collisionParityVerified, false);
  assert.ok(evaluation.reasons.includes(REASON.WORLD_MISSING));
});

test('паритет импульсов требует, чтобы удары вообще случались', () => {
  const evaluation = evaluateMovementParity(goodMetrics({ impulses: 0 }));
  // Столкновения подтверждены, импульсы — нет: это разные утверждения.
  assert.equal(evaluation.collisionParityVerified, true);
  assert.equal(evaluation.obstacleParityVerified, false);
  assert.ok(evaluation.reasons.includes(REASON.INSUFFICIENT_IMPULSE_SAMPLES));
});

test('провайдер отдаёт признаки runtime, а падение наблюдаемости не открывает ворота', () => {
  const passing = createMovementParityProvider({
    runtime: { metrics: () => ({ shadowGroundContact: goodMetrics() }) }
  });
  assert.deepEqual(passing(), { collisionParityVerified: true, obstacleParityVerified: true });

  const broken = createMovementParityProvider({
    runtime: {
      metrics() {
        throw new Error('наблюдаемость сломалась');
      }
    }
  });
  assert.deepEqual(broken(), { collisionParityVerified: false, obstacleParityVerified: false });

  const missing = createMovementParityProvider({ runtime: null });
  assert.deepEqual(missing(), { collisionParityVerified: false, obstacleParityVerified: false });
});

test('пороги политики остаются консервативными', () => {
  assert.ok(DEFAULT_MOVEMENT_PARITY_POLICY.minSamples >= 1000);
  assert.equal(DEFAULT_MOVEMENT_PARITY_POLICY.maxShadowGroundedOnlySamples, 0);
  assert.equal(DEFAULT_MOVEMENT_PARITY_POLICY.maxWorldMissingSamples, 0);
  assert.ok(DEFAULT_MOVEMENT_PARITY_POLICY.minGroundAgreementRate >= 0.99);
});

test('singleton guard не пользуется живым провайдером и остаётся закрытым', () => {
  const guard = require('./shadowMovementAuthorityMatchGuard');
  // Провайдер существует и работает — но подключён он не будет, пока пороги не сверены с живой
  // статистикой. Значение по умолчанию у guard обязано остаться отрицательным.
  assert.equal(typeof guard.movementParityProvider, 'function');
  assert.deepEqual(guard.DEFAULT_MOVEMENT_PARITY_EVIDENCE, {
    collisionParityVerified: false,
    obstacleParityVerified: false
  });

  // И решение guard по свежему матчу с валидным shadow-состоянием — legacy, а не shadow.
  const room = { matchId: 'match-parity', mode: 'race' };
  const player = {};
  const decision = guard
    .createShadowMovementAuthorityMatchGuard({
      raceAuthorityGuard: { sourceFor: () => 'shadow' },
      runtimeService: {
        snapshot: () => ({
          matchId: room.matchId,
          state: {
            position: { x: 0, y: 1, z: 0 },
            velocity: { x: 0, y: 0, z: 0 },
            grounded: true
          }
        })
      }
    })
    .decide({ room, player });
  assert.equal(decision.source, 'legacy', 'ворота движения обязаны быть закрыты по умолчанию');
});
