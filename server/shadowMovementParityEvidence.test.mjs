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
    groundModel: {
      samples: 5000,
      agreements: 5000,
      serverGroundedOnly: 0,
      clientGroundedOnly: 0,
      agreementRate: 1
    },
    groundedMismatch: 0,
    shadowGroundedOnly: 0,
    clientGroundedOnly: 0,
    worldMissing: 0,
    impulses: 200,
    wallBounces: 12,
    heightError: { count: 5000, mean: 0.004, p95: 0.01, max: 0.03 },
    freeTrajectoryError: { count: 5000, mean: 0.08, p50: 0.05, p95: 0.2, max: 0.5 },
    hitParity: {
      serverHits: 84,
      clientHits: 85,
      matched: 81,
      serverOnly: 0,
      clientOnly: 4,
      pending: 0,
      matchRate: 81 / 85
    },
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
      groundModel: {
        samples: 0,
        agreements: 0,
        serverGroundedOnly: 0,
        clientGroundedOnly: 0,
        agreementRate: 0
      },
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
  const evaluation = evaluateMovementParity(
    goodMetrics({
      groundModel: {
        samples: 5000,
        agreements: 4999,
        serverGroundedOnly: 1,
        clientGroundedOnly: 0,
        agreementRate: 0.9998
      }
    })
  );
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

// Отрыв меряется квантилями, а не средним: у него тяжёлый хвост, и среднее задают выбросы после
// попаданий. Но САМ отрыв обязан быть ограничен — без этого ворота открылись бы симулятору, чья
// траектория уехала куда угодно: согласие по опоре спрашивается в точке клиента и остаётся
// идеальным, а паритет попаданий обычный дрейф без сбиваний не ловит.
test('редкий выброс отрыва воротам не мешает, если типичный тик в норме', () => {
  const evaluation = evaluateMovementParity(
    goodMetrics({ freeTrajectoryError: { count: 5000, mean: 2, p50: 0.1, p95: 0.9, max: 90 } })
  );
  assert.equal(evaluation.collisionParityVerified, true);
  assert.equal(evaluation.obstacleParityVerified, true);
});

test('уехавшая траектория закрывает ворота, даже когда опора и удары сходятся', () => {
  const byTypical = evaluateMovementParity(
    goodMetrics({ freeTrajectoryError: { count: 5000, mean: 1, p50: 0.9, p95: 1.2, max: 3 } })
  );
  assert.equal(byTypical.collisionParityVerified, false, 'типичный тик вне полосы мягкой коррекции');
  assert.ok(byTypical.reasons.includes(REASON.TRAJECTORY_ERROR));

  const byTail = evaluateMovementParity(
    goodMetrics({ freeTrajectoryError: { count: 5000, mean: 1, p50: 0.1, p95: 4.2, max: 17 } })
  );
  assert.equal(byTail.collisionParityVerified, false, 'жёсткая коррекция чаще одного тика из двадцати');
  assert.equal(byTail.obstacleParityVerified, false, 'условие общее для обоих признаков');
});

test('удар, которого у клиента не было, запрещён полностью', () => {
  const evaluation = evaluateMovementParity(
    goodMetrics({
      hitParity: {
        serverHits: 85,
        clientHits: 85,
        matched: 81,
        serverOnly: 1,
        clientOnly: 3,
        pending: 0,
        matchRate: 81 / 85
      }
    })
  );
  // Опора тут ни при чём: сервер по-прежнему находит тот же пол.
  assert.equal(evaluation.collisionParityVerified, true);
  assert.equal(evaluation.obstacleParityVerified, false);
  assert.ok(evaluation.reasons.includes(REASON.SERVER_ONLY_HITS));
});

test('низкая доля совпадений попаданий закрывает паритет препятствий', () => {
  const evaluation = evaluateMovementParity(
    goodMetrics({
      hitParity: {
        serverHits: 131,
        clientHits: 85,
        matched: 80,
        serverOnly: 0,
        clientOnly: 56,
        pending: 0,
        matchRate: 80 / 136
      }
    })
  );
  assert.equal(evaluation.obstacleParityVerified, false);
  assert.ok(evaluation.reasons.includes(REASON.HIT_MATCH_RATE));
});

test('без ударов доказывать паритет препятствий не на чем', () => {
  const evaluation = evaluateMovementParity(
    goodMetrics({
      hitParity: {
        serverHits: 0,
        clientHits: 0,
        matched: 0,
        serverOnly: 0,
        clientOnly: 0,
        pending: 0,
        matchRate: 0
      }
    })
  );
  assert.equal(evaluation.collisionParityVerified, true, 'опора доказывается отдельно');
  assert.equal(evaluation.obstacleParityVerified, false);
  assert.ok(evaluation.reasons.includes(REASON.INSUFFICIENT_HIT_SAMPLES));
  assert.ok(evaluation.reasons.includes(REASON.HIT_MATCH_RATE), 'нулевая доля не «нейтральна»');
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

test('испорченный снимок не открывает ворота производным полем', () => {
  // Доля согласия считается по счётчикам, а не берётся из метрики: иначе такой набор прошёл бы
  // проверку и открыл паритет столкновений, не имея ни одного совпадения.
  const lying = evaluateMovementParity(
    goodMetrics({
      groundModel: {
        samples: 5000,
        agreements: 0,
        serverGroundedOnly: 0,
        clientGroundedOnly: 5000,
        agreementRate: 1
      }
    })
  );
  assert.equal(lying.collisionParityVerified, false);
  assert.ok(lying.reasons.includes(REASON.GROUND_AGREEMENT));

  // Несходящиеся счётчики — испорченный снимок, а не «почти правда».
  const inconsistent = evaluateMovementParity(
    goodMetrics({
      groundModel: {
        samples: 5000,
        agreements: 4000,
        serverGroundedOnly: 0,
        clientGroundedOnly: 0,
        agreementRate: 0.8
      }
    })
  );
  assert.deepEqual(inconsistent.reasons, [REASON.INVALID_METRICS]);
});

test('пороги политики остаются консервативными', () => {
  assert.ok(DEFAULT_MOVEMENT_PARITY_POLICY.minSamples >= 1000);
  assert.equal(DEFAULT_MOVEMENT_PARITY_POLICY.maxShadowGroundedOnlySamples, 0);
  assert.equal(DEFAULT_MOVEMENT_PARITY_POLICY.maxWorldMissingSamples, 0);
  assert.ok(DEFAULT_MOVEMENT_PARITY_POLICY.minGroundAgreementRate >= 0.99);
  assert.equal(DEFAULT_MOVEMENT_PARITY_POLICY.maxServerOnlyHits, 0);
  assert.ok(DEFAULT_MOVEMENT_PARITY_POLICY.minHitMatchRate >= 0.9);
  // Пороги отрыва — те же числа, по которым живёт реконсиляция: мягкая коррекция и жёсткая.
  assert.equal(DEFAULT_MOVEMENT_PARITY_POLICY.maxFreeTrajectoryErrorP50, 0.3);
  assert.equal(DEFAULT_MOVEMENT_PARITY_POLICY.maxFreeTrajectoryErrorP95, 1.5);
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
