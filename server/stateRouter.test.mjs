import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_STATE, createAppStates } from '../client/core/AppStates.js';
import { StateRouter } from '../client/core/StateRouter.js';

test('StateRouter выполняет enter/exit и не перезапускает текущее состояние', () => {
  const calls = [];
  const context = { value: 7 };
  const router = new StateRouter(context, {
    menu: {
      enter(ctx, payload) {
        calls.push(['enter-menu', ctx.value, payload]);
      },
      exit(ctx, next) {
        calls.push(['exit-menu', ctx.value, next]);
      }
    },
    race: {
      enter(ctx, payload, previous) {
        calls.push(['enter-race', ctx.value, payload, previous]);
      },
      handleMessage(message, ctx) {
        calls.push(['message-race', message, ctx.value]);
      },
      update(dt) {
        calls.push(['update-race', dt]);
      },
      render(alpha) {
        calls.push(['render-race', alpha]);
      }
    }
  });

  assert.equal(router.transition('menu', 'first'), true);
  assert.equal(router.transition('race', 'start'), true);
  assert.equal(router.transition('race', 'snapshot'), false);
  router.update(1 / 60);
  router.render(0.5);

  assert.deepEqual(calls, [
    ['enter-menu', 7, 'first'],
    ['exit-menu', 7, 'race'],
    ['enter-race', 7, 'start', 'menu'],
    ['message-race', 'snapshot', 7],
    ['update-race', 1 / 60],
    ['render-race', 0.5]
  ]);
  assert.throws(() => router.transition('missing'), /неизвестное состояние/);
});

test('состояния приложения согласованно управляют экраном, HUD и вводом', () => {
  const calls = [];
  const game = {
    running: true,
    input: { enabled: true },
    ui: {
      show: value => calls.push(['show', value]),
      hud: (value, options) => calls.push(['hud', value, options])
    }
  };
  const router = new StateRouter(game, createAppStates());

  router.transition(APP_STATE.MENU);
  assert.equal(game.running, false);
  assert.equal(game.input.enabled, false);
  router.transition(APP_STATE.COUNTDOWN, { multiplayer: true });
  router.transition(APP_STATE.RACE);
  assert.equal(game.running, true);
  assert.equal(game.input.enabled, true);
  router.transition(APP_STATE.RESULTS);
  assert.equal(game.running, false);
  assert.equal(game.input.enabled, false);
  assert.deepEqual(calls, [
    ['hud', false, undefined],
    ['show', 'menu'],
    ['show', undefined],
    ['hud', true, { multiplayer: true }]
  ]);
});
