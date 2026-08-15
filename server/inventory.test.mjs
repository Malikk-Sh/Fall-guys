import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { InventoryService } = require('./inventory');
const { MIGRATIONS, migrateDatabase } = require('./migrations');

const EMPTY_LOADOUT = {
  body: 'classic',
  visor: null,
  antenna: null,
  back: null,
  trail: null,
  finish: null
};

function setup() {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const inventory = new InventoryService({ db, accounts });
  const account = accounts.create('Cosmetic Player');
  return { db, accounts, inventory, account };
}

function unlockAchievements(db, accountId, ids, at = 2000) {
  const unlock = db.prepare(`
    INSERT OR IGNORE INTO achievements (account_id, achievement_id, unlocked_at)
    VALUES (?, ?, ?)
  `);
  for (const id of ids) unlock.run(accountId, id, at);
}

test('новый аккаунт получает только серверный default body', () => {
  const { db, inventory, account } = setup();
  const profile = inventory.syncEntitlements(account.id, 1000);
  assert.deepEqual(profile.ownedIds, ['classic']);
  assert.deepEqual(profile.equipped, EMPTY_LOADOUT);
  assert.deepEqual(profile.emotes, [null, null, null, null]);
  db.close();
});

test('клиент не может экипировать предмет, которого нет в server inventory', () => {
  const { db, inventory, account } = setup();
  inventory.syncEntitlements(account.id);
  assert.equal(inventory.equip(account.id, 'visor', 'clear-visor').reason, 'not-owned');
  assert.equal(inventory.equip(account.id, 'body', 'clear-visor').reason, 'wrong-slot');
  assert.equal(inventory.equip(account.id, 'cape', 'clear-visor').reason, 'unknown-slot');
  assert.equal(inventory.equip(account.id, 'body', 'definitely-not-a-cosmetic').reason, 'wrong-slot');
  db.close();
});

test('сервер материализует существующие achievements в cosmetics ownership', () => {
  const { db, inventory, account } = setup();
  unlockAchievements(db, account.id, [
    'coop-ch10-clear',
    'coop-flawless-5',
    'coop-helper-25',
    'coop-campaign-complete'
  ]);

  const profile = inventory.syncEntitlements(account.id, 3000);
  for (const id of ['sky-hero', 'clear-visor', 'rescue-antenna', 'campaign-finish']) {
    assert.ok(profile.ownedIds.includes(id), `${id} выдан сервером`);
  }
  assert.equal(
    profile.ownedIds.includes('sunrise-trail'),
    false,
    'local daily reward не подделывается сервером'
  );
  assert.equal(inventory.equip(account.id, 'visor', 'clear-visor', 4000).ok, true);
  assert.equal(inventory.equip(account.id, 'finish', 'campaign-finish', 4001).ok, true);
  assert.equal(inventory.publicLoadout(account.id).visor, 'clear-visor');
  assert.equal(inventory.publicLoadout(account.id).finish, 'campaign-finish');
  db.close();
});

test('повторный sync идемпотентен и не создаёт дубликаты unlock', () => {
  const { db, inventory, account } = setup();
  inventory.syncEntitlements(account.id, 1000);
  inventory.syncEntitlements(account.id, 2000);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM account_cosmetics WHERE account_id = ?').get(account.id).count,
    1
  );
  db.close();
});

// ── Content & Customization 2.0 ──────────────────────────────────────────────────────────────

test('stat-условия каталога выдаются сервером по гоночной статистике', () => {
  const { db, accounts, inventory, account } = setup();
  for (let index = 0; index < 4; index++) {
    accounts.recordRaceFinish({
      accountId: account.id,
      place: 4,
      finishers: 6,
      finishedAt: 1000 + index
    });
  }

  const profile = inventory.syncEntitlements(account.id, 5000);
  // race.finishes >= 1/2/3/4 — четыре «ранних» предмета из четырёх коллекций.
  for (const id of ['space-astronaut', 'food-burger', 'neon-cyber', 'pirate-captain']) {
    assert.ok(profile.ownedIds.includes(id), `${id} выдан по race.finishes`);
  }
  assert.equal(profile.ownedIds.includes('space-alien'), false, 'race.finishes 5 ещё не достигнут');
  const source = db
    .prepare('SELECT source FROM account_cosmetics WHERE account_id = ? AND cosmetic_id = ?')
    .get(account.id, 'space-astronaut').source;
  assert.equal(source, 'stat:race.finishes>=1');
  db.close();
});

test('сервер никогда не выдаёт rewarded/shop/pass/event предметы сам', () => {
  const { db, accounts, inventory, account } = setup();
  for (let index = 0; index < 60; index++) {
    accounts.recordRaceFinish({ accountId: account.id, place: 1, finishers: 8, finishedAt: 1000 + index });
  }
  unlockAchievements(db, account.id, [
    'coop-ch10-clear',
    'coop-flawless-5',
    'coop-helper-25',
    'coop-campaign-complete',
    'race-win',
    'race-podium',
    'race-veteran-25',
    'race-first-finish'
  ]);
  const profile = inventory.syncEntitlements(account.id, 9000);
  for (const id of [
    'space-void',
    'pirate-abyssal',
    'neon-gl1tch',
    'food-popcorn-finish',
    'pirate-cannon-finish',
    'neon-visor',
    'party-antenna'
  ]) {
    assert.equal(profile.ownedIds.includes(id), false, `${id} не выдаётся сервером сам`);
  }
  db.close();
});

test('слот back проходит те же проверки и снимается, а body снять нельзя', () => {
  const { db, inventory, account } = setup();
  inventory.syncEntitlements(account.id, 1000);
  assert.equal(inventory.equip(account.id, 'back', 'space-oxygen-pack').reason, 'not-owned');

  inventory.grant(account.id, 'space-oxygen-pack', 'test', 1100);
  assert.equal(inventory.equip(account.id, 'back', 'space-oxygen-pack', 1200).ok, true);
  assert.equal(inventory.loadout(account.id).back, 'space-oxygen-pack');

  assert.equal(inventory.equip(account.id, 'back', null, 1300).ok, true);
  assert.equal(inventory.loadout(account.id).back, null);

  assert.equal(inventory.equip(account.id, 'body', null).reason, 'body-required');
  assert.equal(inventory.equip(account.id, 'back', 'space-star-crown').reason, 'wrong-slot');
  db.close();
});

test('emote loadout server-authoritative: слот, владение, дубликаты, очистка', () => {
  const { db, inventory, account } = setup();
  inventory.syncEntitlements(account.id, 1000);

  assert.equal(inventory.equipEmote(account.id, 0, 'food-chefs-kiss').reason, 'not-owned');
  inventory.grant(account.id, 'food-chefs-kiss', 'test', 1100);
  inventory.grant(account.id, 'neon-robot-dance', 'test', 1100);

  assert.equal(inventory.equipEmote(account.id, 0, 'space-star-crown').reason, 'wrong-slot');
  assert.equal(inventory.equipEmote(account.id, 9, 'food-chefs-kiss').reason, 'unknown-slot');
  assert.equal(inventory.equipEmote(account.id, -1, 'food-chefs-kiss').reason, 'unknown-slot');

  assert.deepEqual(inventory.equipEmote(account.id, 0, 'food-chefs-kiss', 1200).emotes, [
    'food-chefs-kiss',
    null,
    null,
    null
  ]);
  // Одна и та же эмоция в двух ячейках — потерянная ячейка, а не удобство.
  assert.deepEqual(inventory.equipEmote(account.id, 2, 'food-chefs-kiss', 1300).emotes, [
    null,
    null,
    'food-chefs-kiss',
    null
  ]);
  assert.deepEqual(inventory.equipEmote(account.id, 1, 'neon-robot-dance', 1400).emotes, [
    null,
    'neon-robot-dance',
    'food-chefs-kiss',
    null
  ]);

  assert.equal(inventory.canPlayEmote(account.id, 'food-chefs-kiss'), true);
  assert.equal(inventory.canPlayEmote(account.id, 'space-moonwalk'), false, 'не выдан');
  assert.equal(inventory.canPlayEmote(account.id, 'classic'), false, 'не эмоция');

  assert.deepEqual(inventory.equipEmote(account.id, 2, null, 1500).emotes, [
    null,
    'neon-robot-dance',
    null,
    null
  ]);
  assert.equal(inventory.canPlayEmote(account.id, 'food-chefs-kiss'), false, 'снята из loadout');
  db.close();
});

test('старый аккаунт переживает миграцию: loadout сохраняется, back становится пустым', () => {
  const db = openDatabase(':memory:');
  // База, поднятая версией сервера до слота «спина».
  migrateDatabase(db, { migrations: MIGRATIONS.slice(0, 16), now: 100 });
  db.prepare(
    'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('legacy-account', 'Старый Игрок', 'hash', 1, 1);
  db.prepare(
    `
    INSERT INTO account_loadout (account_id, body, visor, antenna, trail, finish, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run('legacy-account', 'sky-hero', 'clear-visor', 'rescue-antenna', 'sunrise-trail', 'campaign-finish', 5);
  for (const id of ['sky-hero', 'clear-visor', 'rescue-antenna', 'campaign-finish']) {
    db.prepare(
      'INSERT INTO account_cosmetics (account_id, cosmetic_id, unlocked_at, source) VALUES (?, ?, ?, ?)'
    ).run('legacy-account', id, 5, 'achievement');
  }

  const accounts = new Accounts({ db });
  const inventory = new InventoryService({ db, accounts });
  assert.deepEqual(inventory.loadout('legacy-account'), {
    body: 'sky-hero',
    visor: 'clear-visor',
    antenna: 'rescue-antenna',
    back: null,
    trail: 'sunrise-trail',
    finish: 'campaign-finish'
  });
  const profile = inventory.profile('legacy-account');
  assert.deepEqual(profile.emotes, [null, null, null, null]);
  for (const id of ['sky-hero', 'clear-visor', 'rescue-antenna', 'campaign-finish']) {
    assert.ok(profile.ownedIds.includes(id), `${id} не потерян миграцией`);
  }
  db.close();
});

test('профиль отдаёт прогресс по коллекциям без gameplay-бонусов', () => {
  const { db, inventory, account } = setup();
  inventory.syncEntitlements(account.id, 1000);
  inventory.grant(account.id, 'space-astronaut', 'test', 1100);
  const collections = inventory.profile(account.id).collections;
  assert.equal(collections.length, 4);
  const space = collections.find(entry => entry.id === 'space-trouble');
  assert.deepEqual(
    { total: space.total, owned: space.owned, complete: space.complete },
    { total: 15, owned: 1, complete: false }
  );
  assert.deepEqual(space.mythic, ['space-void']);
  db.close();
});
