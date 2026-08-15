import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { COOP_CHAPTER_IDS } from '../shared/coopChapters.js';

const require = createRequire(import.meta.url);
const { collapseTile, collapseTiles, validateCollapseEvent } = require('./coopCollapseSync.js');

function chapterWithCollapse() {
  return COOP_CHAPTER_IDS.find(chapterId => collapseTiles({ chapterId }).length > 0);
}

test('сервер знает только реальные осыпающиеся плитки текущей главы', () => {
  const chapterId = chapterWithCollapse();
  assert.ok(chapterId, 'в кампании должен быть участок с осыпающимися плитками');
  const tile = collapseTiles({ chapterId })[0];
  assert.ok(tile.id);
  assert.equal(collapseTile({ chapterId }, `collapse:${tile.id}`)?.id, tile.id);
  assert.equal(collapseTile({ chapterId }, 'collapse:нет-такой-плитки'), null);
  assert.equal(collapseTile({ chapterId }, tile.id), null, 'префикс обязателен');
});

test('два сообщения об одной плитке получают одну серверную фазу', () => {
  const chapterId = chapterWithCollapse();
  const tile = collapseTiles({ chapterId })[0];
  const room = { spec: { chapterId }, matchId: 'match-a' };
  const player = { id: 'p1', last: { x: 0, y: 1, z: 0 } };
  const message = { action: 'plate', objectId: `collapse:${tile.id}` };

  const first = validateCollapseEvent(room, player, message, 10_000);
  const duplicate = validateCollapseEvent(room, player, message, 10_120);
  assert.equal(first.ok, true);
  assert.equal(first.relay.action, 'collapse');
  assert.equal(first.relay.objectId, tile.id);
  assert.equal(first.relay.at, 10_000);
  assert.equal(duplicate.relay.at, 10_000, 'сетевой дубль не должен перезапускать таймер');

  // Новый matchId — новый мир: состояние прошлого забега не переезжает в реванш.
  room.matchId = 'match-b';
  const rematch = validateCollapseEvent(room, player, message, 20_000);
  assert.equal(rematch.relay.at, 20_000);
});

test('неизвестный objectId не ретранслируется', () => {
  const chapterId = chapterWithCollapse();
  const room = { spec: { chapterId }, matchId: 'match-a' };
  const player = { id: 'p1', last: { x: 0, y: 1, z: 0 } };
  const result = validateCollapseEvent(
    room,
    player,
    { action: 'plate', objectId: 'collapse:подделка' },
    1_000
  );
  assert.equal(result.ok, false);
  assert.equal(result.relay, undefined);
});
