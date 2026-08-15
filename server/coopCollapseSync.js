'use strict';

// Авторитетное начало событийных обрушений в кооперативе.
//
// Геометрия плиток строится детерминированно из chapterLayout, но момент «на плитку наступили»
// раньше жил только на клиенте. Сервер здесь не симулирует физику: он лишь проверяет, что id
// действительно принадлежит осыпающемуся участку текущей главы, и выдаёт всем одну отметку времени.

const { chapterLayout } = require('../shared/coopChapters.js');

const PREFIX = 'collapse:';

function collapseTiles(spec) {
  if (!spec?.chapterId) return [];
  const tiles = [];
  for (const piece of chapterLayout(spec.chapterId).pieces) {
    if (piece.kind !== 'collapsing') continue;
    const rows = Math.max(3, Math.round(piece.length / 3.2));
    for (let row = 0; row < rows; row++) {
      for (let lane = 0; lane < piece.lanes; lane++) {
        tiles.push({
          id: `${piece.id}-${row}-${lane}`,
          delay: Math.max(0, Number(piece.delay) || 0),
          respawn: Math.max(0, Number(piece.respawn) || 0)
        });
      }
    }
  }
  return tiles;
}

function collapseTile(spec, objectId) {
  const value = String(objectId || '');
  if (!value.startsWith(PREFIX)) return null;
  const id = value.slice(PREFIX.length);
  return collapseTiles(spec).find(tile => tile.id === id) || null;
}

function ensureState(room) {
  if (!room.coopCollapseState || room.coopCollapseState.matchId !== room.matchId) {
    room.coopCollapseState = { matchId: room.matchId, startedAt: new Map() };
  }
  return room.coopCollapseState;
}

function validateCollapseEvent(room, player, message, now = Date.now()) {
  const tile = collapseTile(room?.spec, message?.objectId);
  if (!tile) return { ok: false, reason: 'неизвестная осыпающаяся плитка' };
  if (!player?.last) return { ok: false, reason: 'нет положения игрока' };

  const state = ensureState(room);
  const cycleMs = Math.max(1, Math.round((tile.delay + tile.respawn) * 1000));
  let at = state.startedAt.get(tile.id);
  // Повторный пакет того же события не начинает новый цикл. Это важно при лаге: оба клиента могут
  // почти одновременно заметить одну плитку, но получить обязаны одну и ту же фазу.
  if (!Number.isFinite(at) || now - at >= cycleMs) {
    at = now;
    state.startedAt.set(tile.id, at);
  }

  return {
    ok: true,
    relay: {
      action: 'collapse',
      from: player.id,
      objectId: tile.id,
      at
    }
  };
}

module.exports = { PREFIX, collapseTiles, collapseTile, validateCollapseEvent };
