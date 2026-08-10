import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { InventoryService } = require('./inventory');

function setup() {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const inventory = new InventoryService({ db, accounts });
  const account = accounts.create('Cosmetic Player');
  return { db, accounts, inventory, account };
}

test('новый аккаунт получает только серверный default body', () => {
  const { db, inventory, account } = setup();
  const profile = inventory.syncEntitlements(account.id, 1000);
  assert.deepEqual(profile.ownedIds, ['classic']);
  assert.deepEqual(profile.equipped, {
    body: 'classic',
    visor: null,
    antenna: null,
    trail: null,
    finish: null
  });
  db.close();
});

test('клиент не может экипировать предмет, которого нет в server inventory', () => {
  const { db, inventory, account } = setup();
  inventory.syncEntitlements(account.id);
  assert.equal(inventory.equip(account.id, 'visor', 'clear-visor').reason, 'not-owned');
  assert.equal(inventory.equip(account.id, 'body', 'clear-visor').reason, 'wrong-slot');
  db.close();
});

test('сервер материализует существующие achievements в cosmetics ownership', () => {
  const { db, inventory, account } = setup();
  const unlock = db.prepare(`
    INSERT INTO achievements (account_id, achievement_id, unlocked_at)
    VALUES (?, ?, ?)
  `);
  for (const achievement of [
    'coop-ch10-clear',
    'coop-flawless-5',
    'coop-helper-25',
    'coop-campaign-complete'
  ]) {
    unlock.run(account.id, achievement, 2000);
  }

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
