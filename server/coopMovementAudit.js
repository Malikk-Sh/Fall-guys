'use strict';

// Проверка движения в рукотворных кооперативных главах.
//
// Полная серверная физика здесь не нужна: персонаж остаётся client-authoritative, а сервер
// проверяет только то, что можно доказать из общей data-driven разметки главы и потока состояний.
// Цель — не кикать игрока за единичный шумный пакет, а не допускать в соревновательную таблицу
// систематически невозможное движение.

const { chapterLayout, LANE_WIDTH, COOP_CHECKPOINT_FRAME } = require('../shared/coopChapters.js');
const { crossingPointAtZ, insideCheckpointFrame } = require('../shared/courseProgress.js');

const WINDOW_MS = 2000;
const WINDOW_MIN_SAMPLES = 2;
const HISTORY_LIMIT = 64;
const FREE_FALL_MS = 1500;

// Обычный персонаж бегает 7.7, dive — 10.8. Конвейер и ветер двигают саму позицию, маятник может
// дать короткий импульс, поэтому мгновенные пределы широкие. Систематическую подделку ловит более
// низкий средний потолок за двухсекундное окно.
const MAX_REPORTED_SPEED = 22;
const MAX_OBSERVED_SPEED = 32;
const MAX_SUSTAINED_SPEED = 14.5;

// Обычный прыжок не поднимает центр персонажа даже близко к этой высоте. Единственный штатный
// механизм, который может поднять заметно выше, — сервером подтверждённая катапульта; для неё
// выдаётся короткое исключение через noteAuthoritativeLaunch().
const MAX_HEIGHT_ABOVE_SUPPORT = 8;

// Серверная катапульта может дать импульс около 26 вверх и ~18 по Z. 2.8 секунды покрывают полёт
// с большим запасом, но не дают превратить один законный launch в разрешение летать всю главу.
const LAUNCH_EXCEPTION_MS = 2800;

const ANOMALY_BUDGET = Object.freeze({
  'coop-reported-speed': 4,
  'coop-observed-speed': 6,
  'coop-sustained-speed': 3,
  'coop-off-platform': 3,
  'coop-flight': 2,
  'coop-impossible-height': 2
});

function budgetFor(reason) {
  return ANOMALY_BUDGET[reason] ?? 3;
}

function note(player, reason, findings) {
  const anomalies = player.coopMovementAnomalies || (player.coopMovementAnomalies = {});
  anomalies[reason] = (anomalies[reason] || 0) + 1;
  if (anomalies[reason] > budgetFor(reason) && !findings.includes(reason)) findings.push(reason);
}

function resetCoopMovement(player, { full = false } = {}) {
  player.coopMovementHistory = [];
  player.coopFreeFallSince = null;
  player.coopLastCheckpointAt = null;
  player.coopMotionException = null;
  if (full) player.coopMovementAnomalies = {};
}

function resetCoopMotionHistory(player) {
  player.coopMovementHistory = [];
  player.coopFreeFallSince = null;
}

function noteAuthoritativeLaunch(player, now = Date.now(), durationMs = LAUNCH_EXCEPTION_MS) {
  if (!player) return false;
  player.coopMotionException = {
    type: 'catapult',
    until: now + Math.max(250, Number(durationMs) || LAUNCH_EXCEPTION_MS)
  };
  // Скорость до и после серверного импульса нельзя смешивать в одно sustained-окно.
  resetCoopMotionHistory(player);
  return true;
}

function hasMotionException(player, now = Date.now()) {
  const exception = player?.coopMotionException;
  if (!exception || !Number.isFinite(exception.until) || now > exception.until) {
    if (player) player.coopMotionException = null;
    return false;
  }
  return true;
}

function pieceBounds(piece) {
  return {
    zMin: piece.z - piece.length / 2,
    zMax: piece.z + piece.length / 2
  };
}

function piecesAt(spec, z, margin = 0.8) {
  if (!spec?.chapterId || !Number.isFinite(z)) return [];
  return chapterLayout(spec.chapterId).pieces.filter(piece => {
    const { zMin, zMax } = pieceBounds(piece);
    return z >= zMin - margin && z <= zMax + margin;
  });
}

function splitSupport(piece, x) {
  const laneWidth = (LANE_WIDTH - piece.laneGap) / 2;
  const offset = piece.laneGap / 2 + laneWidth / 2;
  const margin = 1.25;
  return Math.abs(x + offset) <= laneWidth / 2 + margin || Math.abs(x - offset) <= laneWidth / 2 + margin;
}

function supportsX(piece, x) {
  if (!Number.isFinite(x)) return false;
  if (piece.kind === 'splitSpan') return splitSupport(piece, x);
  if (piece.kind === 'movingSpan') {
    // Платформа ездит поперёк трассы. Серверу не нужно воспроизводить её фазу: достаточно знать
    // весь коридор, в котором она физически может находиться. Это намеренно мягкое исключение.
    return Math.abs(x) <= 3 + Math.abs(piece.range || 0) + 1.25;
  }
  return Math.abs(x) <= LANE_WIDTH / 2 + 1.25;
}

function supportHeight(piece, x) {
  if (piece.kind !== 'splitSpan') return 1.2;
  const laneWidth = (LANE_WIDTH - piece.laneGap) / 2;
  const offset = piece.laneGap / 2 + laneWidth / 2;
  return Math.abs(x + offset) <= Math.abs(x - offset) ? 1.2 + (piece.leftY || 0) : 1.2 + (piece.rightY || 0);
}

function supportAt(spec, state) {
  const candidates = piecesAt(spec, state?.z);
  const piece = candidates.find(item => supportsX(item, state.x));
  if (!piece) return null;
  return { piece, y: supportHeight(piece, state.x) };
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0));
}

// Трос ch10 меняет ПОЗИЦИЮ, а не reported velocity. Когда он натянут, observed-speed может быть
// заметно выше обычного бега. Разрешение действует только пока второй серверный player реально
// находится примерно на предельной длине троса.
function tetherActive(room, player, state) {
  const tether = room?.spec?.mechanics?.tether;
  if (!tether || !room?.players) return false;
  const partner = [...room.players.values()].find(
    item => item.id !== player.id && item.last && !item.disconnectedAt
  );
  if (!partner) return false;
  const maxLength = Number(tether.maxLength) || 11;
  const length = distance(state, partner.last);
  // Трос даёт исключение только рядом с собственной предельной длиной. Условие «всё, что дальше
  // maxLength» превращало бы оторвавшегося на полкарты читера в вечный tether-exception.
  return length >= maxLength - 1.5 && length <= maxLength + 4;
}

function auditCoopMovement(room, player, state, now = Date.now()) {
  if (!room || !player || !state || !room.spec?.chapterId) return [];
  const findings = [];
  const previous = player.last;
  const previousAt = player.lastAt;
  const dt = previous && previousAt ? Math.max(0.04, (now - previousAt) / 1000) : null;
  const launched = hasMotionException(player, now);
  const tethered = tetherActive(room, player, state);

  const reported = Math.hypot(state.vx || 0, state.vz || 0);
  if (!launched && reported > MAX_REPORTED_SPEED) note(player, 'coop-reported-speed', findings);

  let observed = 0;
  if (dt) observed = Math.hypot(state.x - previous.x, state.z - previous.z) / dt;
  if (!launched && !tethered && observed > MAX_OBSERVED_SPEED) note(player, 'coop-observed-speed', findings);

  const history = player.coopMovementHistory || (player.coopMovementHistory = []);
  // Catapult/tether samples deliberately break the sustained window instead of merely raising its
  // threshold: otherwise один законный быстрый эпизод отравлял бы ещё две секунды после него.
  if (launched || tethered) history.length = 0;
  else {
    history.push({ at: now, x: state.x, z: state.z });
    while (history.length > HISTORY_LIMIT) history.shift();
    while (history.length > 1 && now - history[0].at > WINDOW_MS) history.shift();
    if (history.length >= WINDOW_MIN_SAMPLES && now - history[0].at >= WINDOW_MS * 0.72) {
      const first = history[0];
      const last = history.at(-1);
      const elapsed = Math.max(0.001, (last.at - first.at) / 1000);
      // Net displacement, а не среднее по пакетам: так проверка не зависит от того, шлёт
      // модифицированный клиент 15 state/s или намеренно опускается до 2–4 state/s. Боковое
      // движение moving platform/fan учитывается, но их реальные скорости далеко ниже порога.
      const sustained = Math.hypot(last.x - first.x, last.z - first.z) / elapsed;
      if (sustained > MAX_SUSTAINED_SPEED) note(player, 'coop-sustained-speed', findings);
    }
  }

  const support = supportAt(room.spec, state);
  if (!launched && state.state === 'ground' && !support) note(player, 'coop-off-platform', findings);

  if (!launched) {
    const expectedY = support?.y ?? 1.2;
    if (state.y > expectedY + MAX_HEIGHT_ABOVE_SUPPORT) note(player, 'coop-impossible-height', findings);
  }

  // В пустоте честный игрок может прыгать/лететь по баллистике, но не удерживать высоту. Это
  // ловит fly/no-clip, не требуя серверу воспроизводить каждый кадр физики.
  if (!support && !launched && !tethered) {
    if (!player.coopFreeFallSince) player.coopFreeFallSince = { at: now, y: state.y };
    else if (now - player.coopFreeFallSince.at >= FREE_FALL_MS) {
      if (state.y >= player.coopFreeFallSince.y - 0.25) note(player, 'coop-flight', findings);
      player.coopFreeFallSince = { at: now, y: state.y };
    }
  } else player.coopFreeFallSince = null;

  return findings;
}

function checkpointWindow(spec, checkpoint) {
  if (!spec?.chapterId || checkpoint < 1 || checkpoint > spec.checkpoints.length) return null;
  const fromZ = checkpoint === 1 ? spec.start.z : spec.checkpoints[checkpoint - 2];
  const toZ = spec.checkpoints[checkpoint - 1];
  const zMin = Math.min(fromZ, toZ);
  const zMax = Math.max(fromZ, toZ);
  const pieces = chapterLayout(spec.chapterId).pieces.filter(piece => {
    const bounds = pieceBounds(piece);
    return bounds.zMax >= zMin && bounds.zMin <= zMax;
  });
  return { fromZ, toZ, distance: Math.abs(fromZ - toZ), pieces };
}

function minimumCheckpointMs(spec, checkpoint) {
  const window = checkpointWindow(spec, checkpoint);
  if (!window) return 0;
  const hasCatapult = window.pieces.some(piece => (piece.props || []).some(prop => prop.type === 'catapult'));
  // Положительный conveyor может добавить к бегу около 4 ед/с. Catapult и tether получают
  // собственные физически достижимые потолки. Это именно нижняя граница, а не target time.
  const maxForwardSpeed = hasCatapult ? 24 : spec.mechanics?.tether ? 22 : 15.5;
  return Math.max(450, Math.round((window.distance / maxForwardSpeed) * 1000));
}

function verifyCoopCheckpoint(player, spec, checkpoint, state, now = Date.now(), previous = null) {
  if (!spec?.chapterId || checkpoint <= (player.checkpoint || 0)) return null;
  const previousAt = player.coopLastCheckpointAt || player.matchStartedAt || now;
  const elapsed = now - previousAt;
  player.coopLastCheckpointAt = now;

  // Место читается В ПЛОСКОСТИ арки — там же, где его читает и сама выдача чекпоинта.
  //
  // Раньше здесь стояло состояние, пришедшее ПОСЛЕ арки, и вместе с выдачей по конечной точке это
  // было согласовано: не засчитали — не проверили. Порознь они дают худший из возможных исходов.
  // Пара честно проходит арку и сразу падает в проём: точка теперь сохраняется правильно, а порог
  // `y < -2` здесь строже порога выдачи `-3`, поэтому падение попадает в него и снимает проверку
  // с ВСЕЙ главы — рекорд, прогресс и награды, — за движение, которое сервер сам признал честным.
  //
  // Отрезок тот же самый, значит и точка обязана быть та же.
  const line = spec.checkpoints?.[player.checkpoint || 0];
  const region = crossingPointAtZ(previous, state, line) || state;

  // Рамка та же, по которой чекпоинт и ВЫДАН: `validateState` читает `COOP_CHECKPOINT_FRAME` для
  // кооперативной спеки, и это теперь одно число на выдачу и на проверку.
  //
  // Пока они стояли врозь (выдача по гоночным |x|<11 без верхней границы, проверка по здешним),
  // промежуток между ними был ловушкой: пересечение сбоку от дорожки чекпоинт выдавало и тем же
  // движением снимало проверку со ВСЕЙ главы. Теперь эта ветка — сторожевая: сойтись рамки обязаны
  // по построению, и её срабатывание означает, что они снова разъехались.
  if (!insideCheckpointFrame(region, COOP_CHECKPOINT_FRAME)) {
    return {
      reason: 'coop-checkpoint-region',
      checkpoint,
      x: Math.round(region.x * 100) / 100,
      y: Math.round(region.y * 100) / 100
    };
  }

  const minimum = minimumCheckpointMs(spec, checkpoint);
  if (elapsed < minimum) {
    return { reason: 'coop-segment-too-fast', checkpoint, elapsed, minimum };
  }
  return null;
}

function minimumFinishMs(spec) {
  if (!spec?.chapterId) return 0;
  const fromZ = spec.checkpoints.at(-1) ?? spec.start.z;
  const distanceToFinish = Math.abs(fromZ - spec.finishZ);
  const maxForwardSpeed = spec.mechanics?.tether ? 22 : 15.5;
  return Math.max(350, Math.round((distanceToFinish / maxForwardSpeed) * 1000));
}

function verifyCoopFinish(player, spec, state, now = Date.now()) {
  if (!spec?.chapterId || !state) return null;
  // Финиш читается по СОСТОЯНИЮ, а не по пересечению: ленты как плоскости у главы нет, есть
  // условие `z < finishZ`. Рамка при этом та же — иначе у одной главы оказалось бы две дорожки.
  if (!insideCheckpointFrame(state, COOP_CHECKPOINT_FRAME)) {
    return {
      reason: 'coop-finish-region',
      x: Math.round(state.x * 100) / 100,
      y: Math.round(state.y * 100) / 100
    };
  }
  const previousAt = player.coopLastCheckpointAt || player.matchStartedAt || now;
  const elapsed = now - previousAt;
  const minimum = minimumFinishMs(spec);
  if (elapsed < minimum) return { reason: 'coop-finish-too-fast', elapsed, minimum };
  return null;
}

module.exports = {
  auditCoopMovement,
  verifyCoopCheckpoint,
  verifyCoopFinish,
  minimumCheckpointMs,
  minimumFinishMs,
  checkpointWindow,
  supportAt,
  tetherActive,
  noteAuthoritativeLaunch,
  hasMotionException,
  resetCoopMovement,
  resetCoopMotionHistory,
  budgetFor,
  MAX_SUSTAINED_SPEED,
  MAX_REPORTED_SPEED,
  MAX_OBSERVED_SPEED,
  LAUNCH_EXCEPTION_MS
};
