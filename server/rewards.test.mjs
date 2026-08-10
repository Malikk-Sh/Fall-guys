import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { InventoryService } = require('./inventory');
const { RewardService, REWARDABLE_COSMETICS } = require('./rewards');

function setup(limit = 3) {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const inventory = new InventoryService({ db, accounts });
  const rewards = new RewardService({ db, inventory, dailyLimit: limit });
  const account = accounts.create('Reward Player');
  return { db, accounts, inventory, rewards, account };
}

test('повтор одного provider callback не выдаёт награду дважды', () => {
  const { db, rewards, account } = setup();
  const input = {
    accountId: account.id,
    source: 'rewarded_ad',
    idempotencyKey: 'provider-event-001',
    now: Date.UTC(2026, 7, 9, 12)
  };
  const first = rewards.grant(input);
  const second = rewards.grant(input);

  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.cosmeticId, first.cosmeticId);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reward_grants').get().count, 1);
  db.close();
});

test('дневной лимит общий для dev и production rewarded sources', () => {
  const { db, rewards, account } = setup(2);
  const now = Date.UTC(2026, 7, 9, 12);

  assert.equal(
    rewards.grant({
      accountId: account.id,
      source: 'dev_rewarded',
      idempotencyKey: 'dev-a',
      now
    }).ok,
    true
  );
  assert.equal(
    rewards.grant({
      accountId: account.id,
      source: 'rewarded_ad',
      idempotencyKey: 'provider-b',
      now
    }).ok,
    true
  );
  assert.equal(
    rewards.grant({
      accountId: account.id,
      source: 'rewarded_ad',
      idempotencyKey: 'provider-c',
      now
    }).reason,
    'daily-limit'
  );
  db.close();
});

test('reward pool использует только server-owned cosmetics реальных slots', () => {
  assert.deepEqual(REWARDABLE_COSMETICS, ['neon-visor', 'party-antenna']);

  const { db, rewards, inventory, account } = setup();
  const before = db.prepare('SELECT * FROM account_stats WHERE account_id = ?').get(account.id);
  const result = rewards.grant({
    accountId: account.id,
    source: 'dev_rewarded',
    idempotencyKey: 'dev-1',
    now: Date.UTC(2026, 7, 9, 12)
  });

  assert.equal(result.ok, true);
  assert.ok(inventory.owns(account.id, result.cosmeticId));
  assert.ok(
    ['visor', 'antenna'].includes(
      inventory.owned(account.id).find(item => item.id === result.cosmeticId)?.slot
    )
  );
  const after = db.prepare('SELECT * FROM account_stats WHERE account_id = ?').get(account.id);
  assert.deepEqual(after, before, 'reward не меняет race/gameplay stats');
  db.close();
});

test('исчерпанный cosmetic pool не создаёт пустой reward grant', () => {
  const { db, rewards, account } = setup(3);
  const now = Date.UTC(2026, 7, 9, 12);

  for (const idempotencyKey of ['reward-1', 'reward-2']) {
    assert.equal(
      rewards.grant({ accountId: account.id, source: 'rewarded_ad', idempotencyKey, now }).ok,
      true
    );
  }
  assert.equal(
    rewards.grant({
      accountId: account.id,
      source: 'rewarded_ad',
      idempotencyKey: 'reward-3',
      now
    }).reason,
    'pool-exhausted'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reward_grants').get().count, 2);
  db.close();
});

test('неизвестный account не создаёт ledger row', () => {
  const { db, rewards } = setup();
  const result = rewards.grant({
    accountId: 'missing-account',
    source: 'dev_rewarded',
    idempotencyKey: 'missing-1',
    now: Date.UTC(2026, 7, 9, 12)
  });

  assert.deepEqual(result, { ok: false, reason: 'unknown-account' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reward_grants').get().count, 0);
  db.close();
});
