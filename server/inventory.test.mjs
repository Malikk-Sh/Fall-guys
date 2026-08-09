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
  assert.deepEqual(profile.ownedIds, ['body-mint']);
  assert.deepEqual(profile.equipped, {
    body: 'body-mint',
    head: 'none',
    trail: 'none',
    finish: 'none',
  });
  db.close();
});

test('клиент не может экипировать предмет, которого нет в server inventory', () => {
  const { db, inventory, account } = setup();
  inventory.syncEntitlements(account.id);
  assert.equal(inventory.equip(account.id, 'head', 'head-crown').reason, 'not-owned');
  assert.equal(
    inventory.equip(account.id, 'body', 'head-crown').reason,
    'wrong-slot'
  );
  db.close();
});

test('сервер материализует достижения в cosmetics ownership и проверяет loadout', () => {
  const { db, inventory, account } = setup();
  db.prepare(
    `
    INSERT INTO account_achievements (account_id, achievement_id, unlocked_at)
    VALUES (?, 'campaign_complete', ?)
  `
  ).run(account.id, 2000);
  db.prepare(
    `
    UPDATE account_stats
    SET flawless_completions = 3, coop_matches_completed = 12, best_streak = 3
    WHERE account_id = ?
  `
  ).run(account.id);

  const profile = inventory.syncEntitlements(account.id, 3000);
  for (const id of [
    'body-sunset',
    'head-crown',
    'trail-spark',
    'finish-stars',
    'finish-champion',
  ]) {
    assert.ok(profile.ownedIds.includes(id), `${id} выдан сервером`);
  }
  assert.equal(inventory.equip(account.id, 'head', 'head-crown', 4000).ok, true);
  assert.equal(
    inventory.equip(account.id, 'finish', 'finish-champion', 4001).ok,
    true
  );
  assert.equal(inventory.publicLoadout(account.id).head, 'head-crown');
  assert.equal(inventory.publicLoadout(account.id).finish, 'finish-champion');
  db.close();
});

test('повторный sync идемпотентен и не создаёт дубликаты unlock', () => {
  const { db, inventory, account } = setup();
  inventory.syncEntitlements(account.id, 1000);
  inventory.syncEntitlements(account.id, 2000);
  assert.equal(
    db
      .prepare(
        'SELECT COUNT(*) AS count FROM account_cosmetics WHERE account_id = ?'
      )
      .get(account.id).count,
    1
  );
  db.close();
});
