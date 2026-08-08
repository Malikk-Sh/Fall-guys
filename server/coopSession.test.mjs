import test from 'node:test';
import assert from 'node:assert/strict';
import { CoopSession } from '../client/game/CoopSession.js';

test('CoopSession назначает роли и сбрасывает состояние пары между главами', () => {
  const session = new CoopSession().start({
    selfId: 'p2',
    slots: { p1: 0, p2: 1 },
    partnerAway: true
  });
  assert.equal(session.active, true);
  assert.equal(session.mySlot, 1);
  assert.equal(session.slotFor('p1'), 0);
  assert.equal(session.slotFor('unknown'), 0);
  assert.equal(session.partnerAway, true);
  session.reset();
  assert.equal(session.active, false);
  assert.equal(session.partnerAway, false);
});

test('CoopSession сводит downed/revive к состоянию напарника и визуальным эффектам', () => {
  const session = new CoopSession().start({ selfId: 'self' });
  assert.deepEqual(session.applyEvent({ action: 'downed', target: 'partner' }), {
    type: 'down-partner'
  });
  assert.equal(session.partnerDown, true);
  assert.equal(session.canRevive({ localDowned: false, distance: 3.5 }), true);
  assert.equal(session.canRevive({ localDowned: true, distance: 1 }), false);
  assert.equal(session.canRevive({ localDowned: false, distance: 3.51 }), false);
  assert.deepEqual(session.applyEvent({ action: 'revive', target: 'partner' }), {
    type: 'revive-partner'
  });
  assert.equal(session.partnerDown, false);
  assert.equal(session.revives, 1);
  session.applyEvent({ action: 'revive', target: 'self' });
  assert.equal(session.revives, 1);
});

test('CoopSession отличает события локального игрока от событий напарника', () => {
  const session = new CoopSession().start({ selfId: 'self' });
  const vector = { x: 0, y: 12, z: -8 };
  assert.deepEqual(session.applyEvent({ action: 'launch', target: 'self', vector }), {
    type: 'launch-self',
    vector
  });
  assert.deepEqual(session.applyEvent({ action: 'downed', target: 'self' }), { type: 'down-self' });
  assert.deepEqual(session.applyEvent({ action: 'revive', target: 'self' }), { type: 'revive-self' });
  assert.equal(session.applyEvent({ action: 'launch', target: 'partner', vector }), null);
  session.reset();
  assert.equal(session.applyEvent({ action: 'downed', target: 'partner' }), null);
});

// Остался ли игрок один. Правило короткое, но каждая из трёх веток стоит дорого, если ошибиться.
test('одиночество считается по составу комнаты, а не по молчанию напарника', () => {
  const me = 'a';
  assert.equal(
    CoopSession.soloFromRoster(undefined, me),
    null,
    'состава нет — это «неизвестно», а не «никого нет»'
  );
  assert.equal(CoopSession.soloFromRoster([{ id: me }, { id: 'b' }], me), false);
  assert.equal(
    CoopSession.soloFromRoster([{ id: me }, { id: 'b', online: false }], me),
    false,
    'оборвавшийся напарник держит слот 30 секунд — короткий обрыв главу не упрощает'
  );
  assert.equal(CoopSession.soloFromRoster([{ id: me }], me), true, 'напарника в составе нет — один');
});
