// Синхронизация событийных препятствий кооператива.
//
// Периодические механизмы (прессы, маятники, вентиляторы, движущиеся пролёты) уже считаются от
// общего серверного времени. Отдельный канал нужен только объектам, чьё состояние начинается от
// действия игрока. Главное такое место — осыпающаяся плитка: раньше её таймер заводил только
// локальный Player.interact, поэтому напарник видел человека над совершенно целым полом.

import { movePlatform } from './CourseBuilder.js';

const PLAYER_FOOT = 0.48;
const TILE_TOP_Y = 0.5;

function standsOnTile(position, tile) {
  if (!position || !tile?.platform?.mesh) return false;
  if (Math.abs(position.x - tile.platform.x) > tile.platform.w / 2) return false;
  if (Math.abs(position.z - tile.platform.z) > tile.platform.d / 2) return false;
  return Math.abs(position.y - PLAYER_FOOT - TILE_TOP_Y) < 0.6;
}

/**
 * Найти целую плитку под игроком и оптимистично запустить её локально, одновременно отправив
 * запрос серверу. Сервер вернёт тот же объект всем участникам с одной отметкой времени; ответ
 * затем выровняет фазу через applyCollapseEvent.
 */
export function requestCollapseUnderPlayer(course, position, send, sfx = null) {
  if (!course?.tiles?.length || typeof send !== 'function') return null;
  for (const tile of course.tiles) {
    if (tile.fallen || tile.timer !== 0 || tile.collapseRequested) continue;
    if (!standsOnTile(position, tile)) continue;

    tile.collapseRequested = true;
    // Оптимистичный старт убирает ощущение задержки на собственном устройстве. Авторитетная
    // отметка сервера, пришедшая следом, поправит оставшееся время на величину RTT.
    tile.timer = tile.delay;
    sfx?.crack(tile.platform.mesh.position);
    const sent = send(tile.id);
    if (sent === false) {
      tile.collapseRequested = false;
      tile.timer = 0;
      return null;
    }
    return tile.id;
  }
  return null;
}

/**
 * Применить подтверждённое сервером обрушение. `at` — серверное время начала события.
 *
 * Клиенты получают пакет с разной сетевой задержкой. Если просто поставить timer=delay в момент
 * получения, плитка у каждого упадёт в свой момент. Здесь задержка вычитается сразу, поэтому после
 * одного сообщения оба клиента оказываются в одной фазе цикла.
 */
export function applyCollapseEvent(course, { objectId, at } = {}, nowMs = Date.now()) {
  if (!course?.tiles?.length || !objectId) return false;
  const tile = course.tiles.find(item => item.id === objectId);
  if (!tile) return false;

  tile.collapseRequested = false;
  const startedAt = Number.isFinite(at) ? at : nowMs;
  const age = Math.max(0, (nowMs - startedAt) / 1000);
  const delay = Math.max(0, Number(tile.delay) || 0);
  const respawn = Math.max(0, Number(tile.respawn) || 0);
  const mesh = tile.platform.mesh;

  if (age < delay) {
    tile.fallen = false;
    tile.timer = Math.max(0.001, delay - age);
    tile.platform.disabled = false;
    mesh.visible = true;
    return true;
  }

  if (age < delay + respawn) {
    tile.fallen = true;
    tile.timer = Math.max(0.001, respawn - (age - delay));
    tile.platform.disabled = true;
    mesh.visible = false;
    movePlatform(tile.platform, 'y', tile.baseY);
    return true;
  }

  // Пакет мог приехать очень поздно после сна вкладки. Цикл уже закончился — не проигрываем его
  // задним числом, а сразу приводим объект к текущему состоянию.
  tile.fallen = false;
  tile.timer = 0;
  tile.platform.disabled = false;
  mesh.visible = true;
  movePlatform(tile.platform, 'y', tile.baseY);
  return true;
}
