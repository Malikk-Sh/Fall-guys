'use strict';

// Доказательства паритета движения.
//
// Guard движения ждёт двух признаков: сходится ли серверная опора с клиентской и сходятся ли
// импульсы препятствий. До сих пор их отдавала константа `false` — не потому, что так решили, а
// потому, что мерить было нечего: у сервера не было ни своей геометрии, ни своей траектории.
//
// Теперь измерение есть, и признаки считаются по нему. Политика написана так же, как политика
// готовности прогресса гонки: fail-closed по построению, консервативные пороги и обязательный
// минимум выборок. Пока живых прогонов не накопилось, ответ остаётся отрицательным — и это не
// недостаток, а требуемое поведение.
const DEFAULT_MOVEMENT_PARITY_POLICY = Object.freeze({
  // Меньше этого числа шагов — статистики нет, а не «всё хорошо».
  minSamples: 3000,
  // Доля тиков, где сервер и клиент одинаково отвечают на вопрос «игрок на опоре».
  minGroundAgreementRate: 0.995,
  // Сервер, считающий игрока стоящим там, где клиент падает, опаснее обратного: так игрок мог бы
  // получить пол из воздуха. Такой перекос запрещён полностью.
  maxShadowGroundedOnlySamples: 0,
  // Расхождение по высоте стояния — прямое следствие разной геометрии опоры.
  maxGroundHeightErrorMean: 0.02,
  maxGroundHeightErrorMax: 0.12,
  // Свободная траектория не обязана совпадать с клиентом до последнего разряда: у неё нет ни
  // сетевой задержки, ни коррекций. Но её отрыв обязан оставаться в пределах мягкой коррекции,
  // иначе переключение обернулось бы рывком на экране.
  maxFreeTrajectoryErrorMean: 0.3,
  maxFreeTrajectoryErrorMax: 1.5,
  // Ни одного тика без мира: матч, где геометрия не построилась, доказательством быть не может.
  maxWorldMissingSamples: 0,
  // Импульсы обязаны хоть раз случиться, иначе их паритет ничем не подтверждён.
  minImpulseSamples: 50
});

const REASON = Object.freeze({
  INVALID_METRICS: 'invalid-metrics',
  INSUFFICIENT_SAMPLES: 'insufficient-samples',
  WORLD_MISSING: 'world-missing',
  GROUND_AGREEMENT: 'ground-agreement',
  SHADOW_GROUNDED_ONLY: 'shadow-grounded-only',
  GROUND_HEIGHT_ERROR: 'ground-height-error',
  TRAJECTORY_ERROR: 'trajectory-error',
  INSUFFICIENT_IMPULSE_SAMPLES: 'insufficient-impulse-samples'
});

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validErrorStats(stats) {
  return (
    !!stats &&
    typeof stats === 'object' &&
    finiteNonNegative(stats.count) &&
    finiteNonNegative(stats.mean) &&
    finiteNonNegative(stats.max)
  );
}

function validMetrics(metrics) {
  return (
    !!metrics &&
    typeof metrics === 'object' &&
    finiteNonNegative(metrics.samples) &&
    finiteNonNegative(metrics.agreements) &&
    finiteNonNegative(metrics.shadowGroundedOnly) &&
    finiteNonNegative(metrics.worldMissing) &&
    finiteNonNegative(metrics.impulses) &&
    validErrorStats(metrics.heightError) &&
    validErrorStats(metrics.freeTrajectoryError)
  );
}

// Оценивает измерение свободной траектории и отвечает теми признаками, которых ждёт guard.
//
// Неизвестные или испорченные метрики — не «нейтральный» случай: это отказ. Доказательство обязано
// быть предъявлено, а не подразумеваться.
function evaluateMovementParity(metrics, policy = DEFAULT_MOVEMENT_PARITY_POLICY) {
  const reasons = [];
  if (!validMetrics(metrics)) {
    return Object.freeze({
      collisionParityVerified: false,
      obstacleParityVerified: false,
      reasons: Object.freeze([REASON.INVALID_METRICS])
    });
  }

  if (metrics.samples < policy.minSamples) reasons.push(REASON.INSUFFICIENT_SAMPLES);
  if (metrics.worldMissing > policy.maxWorldMissingSamples) reasons.push(REASON.WORLD_MISSING);

  const agreementRate = metrics.samples ? metrics.agreements / metrics.samples : 0;
  if (agreementRate < policy.minGroundAgreementRate) reasons.push(REASON.GROUND_AGREEMENT);
  if (metrics.shadowGroundedOnly > policy.maxShadowGroundedOnlySamples) {
    reasons.push(REASON.SHADOW_GROUNDED_ONLY);
  }
  if (
    metrics.heightError.mean > policy.maxGroundHeightErrorMean ||
    metrics.heightError.max > policy.maxGroundHeightErrorMax
  ) {
    reasons.push(REASON.GROUND_HEIGHT_ERROR);
  }
  if (
    metrics.freeTrajectoryError.mean > policy.maxFreeTrajectoryErrorMean ||
    metrics.freeTrajectoryError.max > policy.maxFreeTrajectoryErrorMax
  ) {
    reasons.push(REASON.TRAJECTORY_ERROR);
  }

  // Паритет столкновений и паритет импульсов — разные утверждения, и второе требует, чтобы удары
  // вообще случались. Общие препятствия к тому моменту уже отработали, но без выборки доказывать
  // нечего.
  const collisionParityVerified = reasons.length === 0;
  const impulseReasons = [...reasons];
  if (metrics.impulses < policy.minImpulseSamples) {
    impulseReasons.push(REASON.INSUFFICIENT_IMPULSE_SAMPLES);
    reasons.push(REASON.INSUFFICIENT_IMPULSE_SAMPLES);
  }

  return Object.freeze({
    collisionParityVerified,
    obstacleParityVerified: impulseReasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)])
  });
}

// Провайдер для guard движения: читает метрики runtime и отдаёт признаки.
//
// Ошибка чтения метрик — тоже отказ: наблюдаемость не должна уметь открывать ворота.
function createMovementParityProvider({ runtime, policy = DEFAULT_MOVEMENT_PARITY_POLICY } = {}) {
  return () => {
    let metrics = null;
    try {
      metrics = runtime?.metrics?.().shadowGroundContact ?? null;
    } catch {
      metrics = null;
    }
    const evaluation = evaluateMovementParity(metrics, policy);
    return {
      collisionParityVerified: evaluation.collisionParityVerified,
      obstacleParityVerified: evaluation.obstacleParityVerified
    };
  };
}

module.exports = Object.freeze({
  DEFAULT_MOVEMENT_PARITY_POLICY,
  REASON,
  createMovementParityProvider,
  evaluateMovementParity
});
