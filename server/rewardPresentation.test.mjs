import test from 'node:test';
import assert from 'node:assert/strict';
import { freshRewardIds, rewardRevealSafe } from '../client/ui/RewardRevealQueue.js';
import { milestonePresentationState } from '../client/ui/WardrobeMilestonePresentation.js';

test('reward reveal is safe only on menu/results screens', () => {
  assert.equal(rewardRevealSafe('menu'), true);
  assert.equal(rewardRevealSafe('results'), true);
  assert.equal(rewardRevealSafe('race'), false);
  assert.equal(rewardRevealSafe('countdown'), false);
  assert.equal(rewardRevealSafe('spectate'), false);
  assert.equal(rewardRevealSafe(null), false);
});

test('reward queue keeps only valid unseen cosmetic ids', () => {
  const seen = new Set(['classic']);
  const fresh = freshRewardIds(['classic', 'clear-visor', 'clear-visor', 'not-real'], seen);
  assert.deepEqual(fresh, ['clear-visor']);
});

test('milestone presentation distinguishes locked, reached and newly reached rewards', () => {
  const reward = { id: 'reward-a', owned: false };
  assert.equal(milestonePresentationState(reward, new Set(), new Set()), 'locked');
  reward.owned = true;
  assert.equal(milestonePresentationState(reward, new Set(['reward-a']), new Set()), 'reached');
  assert.equal(milestonePresentationState(reward, new Set(), new Set()), 'new');
  assert.equal(milestonePresentationState(reward, new Set(['reward-a']), new Set(['reward-a'])), 'new');
});
