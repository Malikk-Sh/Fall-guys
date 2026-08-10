import test from 'node:test';
import assert from 'node:assert/strict';
import { PwaController, updateButtonLabel } from '../client/core/pwa.js';

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
