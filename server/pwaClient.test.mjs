import test from 'node:test';
import assert from 'node:assert/strict';
import { PwaController, updateButtonLabel } from '../client/core/pwa.js';
import {
  MobileExperience,
  gameplayInputAllowed,
  isTouchMobile,
  mobileOrientationState
} from '../client/ui/MobileExperience.js';
import './contextActionControl.test.mjs';
import './coopCelebrationPresentation.test.mjs';
import './resultsPresentation.test.mjs';

function classList() {
  const values = new Set(['hidden']);
  return {
    add: value => values.add(value),
    remove: value => values.delete(value),
    toggle: (value, force) => (force ? values.add(value) : values.delete(value)),
    contains: value => values.has(value)
  };
}
function element() {
  return {
    classList: classList(),
    dataset: {},
    disabled: false,
    textContent: '',
    listeners: new Map(),
    addEventListener(type, fn) {
      this.listeners.set(type, fn);
    }
  };
}

test('update label явно откладывает reload во время забега', () => {
  assert.equal(updateButtonLabel({ safe: false, requested: false }), 'ОБНОВИТЬ ПОСЛЕ ЗАБЕГА');
  assert.equal(updateButtonLabel({ safe: true, requested: false }), 'ОБНОВИТЬ СЕЙЧАС');
  assert.equal(updateButtonLabel({ safe: false, requested: true }), 'ОБНОВИМ ПОСЛЕ ЗАБЕГА');
});

test('waiting service worker получает SKIP_WAITING только после окончания активного забега', () => {
  const updateBanner = element();
  const applyUpdate = element();
  const installApp = element();
  const offlineBanner = element();
  const elements = { updateBanner, applyUpdate, installApp, offlineBanner };
  const documentRef = { getElementById: id => elements[id] || null };
  const messages = [];
  const waiting = { postMessage: message => messages.push(message) };
  let running = true;
  let poll = null;
  const controller = new PwaController({
    navigatorRef: { onLine: true },
    documentRef,
    windowRef: {},
    isSafeToReload: () => !running,
    setIntervalImpl: fn => {
      poll = fn;
      return 7;
    },
    clearIntervalImpl: () => {}
  });
  controller.offerUpdate(waiting);
  assert.equal(controller.requestUpdate(), true);
  assert.deepEqual(messages, []);
  assert.equal(applyUpdate.textContent, 'ОБНОВИМ ПОСЛЕ ЗАБЕГА');
  running = false;
  poll();
  assert.deepEqual(messages, [{ type: 'SKIP_WAITING' }]);
});

test('mobile orientation policy блокирует только touch portrait без accessibility override', () => {
  assert.equal(isTouchMobile({ coarse: true, hoverNone: true, maxTouchPoints: 0 }), true);
  assert.equal(isTouchMobile({ coarse: false, hoverNone: true, maxTouchPoints: 2 }), true);
  assert.equal(isTouchMobile({ coarse: false, hoverNone: false, maxTouchPoints: 2 }), false);
  assert.equal(isTouchMobile({ coarse: false, hoverNone: false, maxTouchPoints: 0 }), false);

  assert.deepEqual(mobileOrientationState({ mobile: true, width: 375, height: 667 }), {
    mobile: true,
    landscape: false,
    blocked: true
  });
  assert.deepEqual(
    mobileOrientationState({ mobile: true, width: 375, height: 667, portraitOverride: true }),
    { mobile: true, landscape: false, blocked: false }
  );
  assert.deepEqual(mobileOrientationState({ mobile: true, width: 844, height: 390 }), {
    mobile: true,
    landscape: true,
    blocked: false
  });
  assert.deepEqual(mobileOrientationState({ mobile: false, width: 375, height: 667 }), {
    mobile: false,
    landscape: false,
    blocked: false
  });
});

test('после portrait gate ввод возвращается только в игровых AppState', () => {
  assert.equal(gameplayInputAllowed('menu'), false);
  assert.equal(gameplayInputAllowed('lobby'), false);
  assert.equal(gameplayInputAllowed('countdown'), false);
  assert.equal(gameplayInputAllowed('results'), false);
  assert.equal(gameplayInputAllowed('race'), true);
  assert.equal(gameplayInputAllowed('spectate'), true);
});

test('MobileExperience прекращает ожидание Game после startup error', () => {
  let scheduled = 0;
  const root = {
    querySelector(selector) {
      return selector === '#error:not(.hidden)' ? {} : null;
    }
  };
  const windowRef = {
    navigator: { maxTouchPoints: 0 },
    requestAnimationFrame() {
      scheduled += 1;
      return scheduled;
    }
  };
  const experience = new MobileExperience({ root, windowRef, storage: null });
  experience.bindGameWhenReady();
  assert.equal(scheduled, 0);
  assert.equal(experience.gameWaitAttempts, 0);
});
