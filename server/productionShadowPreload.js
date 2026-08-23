'use strict';

// Production loads the shadow migration bridge before bootstrap. roomBots, however, installs an
// asynchronous ESM loader from preloadBots(). If that loader is registered while index.js is still
// doing synchronous require() calls of syntax-detected ESM from shared/, Node 22 cannot service the
// required resolveSync() hook and aborts startup with ERR_METHOD_NOT_IMPLEMENTED.
//
// Keep the existing bot loader and its retry behaviour, but postpone the *call* that registers it
// until the current CommonJS startup stack has completed. index.js/bootstrap.js can then finish all
// synchronous requires using Node's normal resolver; the bot-only loader is installed immediately
// afterwards for the dynamic client imports it was designed for.
const roomBots = require('./roomBots');
const DEFERRED_PRELOAD = Symbol.for('wobble.production-deferred-bot-preload');

if (!roomBots[DEFERRED_PRELOAD]) {
  const preloadBots = roomBots.preloadBots;
  let pending = null;

  roomBots.preloadBots = function deferredPreloadBots() {
    if (pending) return pending;
    pending = Promise.resolve()
      .then(() => preloadBots())
      .catch(error => {
        pending = null;
        throw error;
      });
    return pending;
  };

  Object.defineProperty(roomBots, DEFERRED_PRELOAD, { value: true });
}

// Load the migration/parity bridge while the normal synchronous resolver is still in control.
require('./shadowInputPreload');
