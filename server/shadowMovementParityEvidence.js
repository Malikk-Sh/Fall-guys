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
  // Ни одного тика без мира: матч, где геометрия не построилась, доказательством быть не может.
  maxWorldMissingSamples: 0,
  // Импульсы обязаны хоть раз случиться, иначе про них нечего утверждать.
  minImpulseSamples: 50,
  // Паритет препятствий меряется СОБЫТИЯМИ, а не расстоянием.
  //
  // Раньше здесь стоял порог на отрыв свободной траектории — среднее 0.3, максимум 1.5. Замер
  // показал, что эта величина описывает не то: внутри секундного окна всё определяет одно
  // попадание, а попадания усиливают расхождение скачком — попал или нет решают доли единицы, а
  // после попадания разница измеряется метрами. Среднее по такому распределению не значит ничего,
  // и калибровать его было бы работой впустую.
  //
  // Вопрос ставится прямо: бьёт ли сервер по тем же препятствиям, что и клиент. Сбивающие удары
  // видны с обеих сторон — у сервера как событие импульса, у клиента как переход снапшота в
  // `knockdown`, — и сопоставляются во времени с допуском.
  minHitSamples: 40,
  minHitMatchRate: 0.9,
  // Удар, которого у клиента не было, опаснее пропущенного: так игрока сбивало бы на ровном месте.
  // Отношение к `clientOnly` мягче — пропуск лишь означает, что сервер не воспроизвёл удар, и это
  // ловится общей долей совпадений.
  maxServerOnlyHits: 0
});

const REASON = Object.freeze({
  INVALID_METRICS: 'invalid-metrics',
  INSUFFICIENT_SAMPLES: 'insufficient-samples',
  WORLD_MISSING: 'world-missing',
  GROUND_AGREEMENT: 'ground-agreement',
  SHADOW_GROUNDED_ONLY: 'shadow-grounded-only',
  GROUND_HEIGHT_ERROR: 'ground-height-error',
  INSUFFICIENT_IMPULSE_SAMPLES: 'insufficient-impulse-samples',
  INSUFFICIENT_HIT_SAMPLES: 'insufficient-hit-samples',
  HIT_MATCH_RATE: 'hit-match-rate',
  SERVER_ONLY_HITS: 'server-only-hits'
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

function validHitParity(parity) {
  return (
    !!parity &&
    typeof parity === 'object' &&
    finiteNonNegative(parity.matched) &&
    finiteNonNegative(parity.serverOnly) &&
    finiteNonNegative(parity.clientOnly) &&
    finiteNonNegative(parity.matchRate)
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
    validHitParity(metrics.hitParity)
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
  // Паритет столкновений и паритет препятствий — разные утверждения. Первое про опору: находит ли
  // сервер тот же пол. Второе про удары: бьёт ли он по тем же препятствиям.
  const collisionParityVerified = reasons.length === 0;

  const impulseReasons = [...reasons];
  const hits = metrics.hitParity;
  const decidedHits = hits.matched + hits.serverOnly + hits.clientOnly;
  if (metrics.impulses < policy.minImpulseSamples) impulseReasons.push(REASON.INSUFFICIENT_IMPULSE_SAMPLES);
  if (decidedHits < policy.minHitSamples) impulseReasons.push(REASON.INSUFFICIENT_HIT_SAMPLES);
  if (hits.matchRate < policy.minHitMatchRate) impulseReasons.push(REASON.HIT_MATCH_RATE);
  if (hits.serverOnly > policy.maxServerOnlyHits) impulseReasons.push(REASON.SERVER_ONLY_HITS);
  for (const reason of impulseReasons) if (!reasons.includes(reason)) reasons.push(reason);

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
