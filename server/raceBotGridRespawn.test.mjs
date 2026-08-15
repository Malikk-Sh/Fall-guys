import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { preloadBots, spawnBots, clearBots } = require('./roomBots');
const { createCourseSpec } = require('./gameRules');

await preloadBots();

function room() {
  return {
    code: 'GRIDBOT',
    mode: 'race',
    state: 'COUNTDOWN',
    spec: createCourseSpec(7777, 'normal'),
    players: new Map(),
    nextJoinOrder: 0,
    startedAt: Date.now() + 1000,
    bots: null
  };
}

test('бот до первого checkpoint возрождается в своей grid-клетке, а не в центре', () => {
  const r = room();
  spawnBots(r, { count: 4 });
  const entry = r.bots.list[0];
  const bot = entry.bot;
  const assigned = bot.position.clone();

  assert.equal(bot.player.spawn.x, assigned.x);
  assert.equal(bot.player.spawn.y, assigned.y);
  assert.equal(bot.player.spawn.z, assigned.z);

  bot.player.teleport(assigned.clone().addScalar(6));
  bot.player.respawn(null, false);

  assert.equal(bot.position.x, assigned.x);
  assert.equal(bot.position.y, assigned.y);
  assert.equal(bot.position.z, assigned.z);
  clearBots(r);
});
