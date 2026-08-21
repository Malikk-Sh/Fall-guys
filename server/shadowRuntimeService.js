'use strict';

const { ShadowInputRuntime } = require('./shadowInputRuntime');

const REQUIRED_METHODS = Object.freeze(['accept', 'tick', 'snapshot', 'metrics', 'release']);

function createShadowRuntimeService({ runtime = new ShadowInputRuntime() } = {}) {
  if (!runtime || REQUIRED_METHODS.some(method => typeof runtime[method] !== 'function')) {
    throw new TypeError(
      'shadow runtime service requires accept, tick, snapshot, metrics and release methods'
    );
  }

  return {
    runtime,
    accept: options => runtime.accept(options),
    tick: (rooms, now) => runtime.tick(rooms, now),
    snapshot: player => runtime.snapshot(player),
    // Уход игрока: закрыть его сопоставление ударов, пока контроллер ещё достижим.
    release: player => runtime.release(player),
    metrics: () => runtime.metrics()
  };
}

const singleton = createShadowRuntimeService();

module.exports = Object.freeze({
  ...singleton,
  createShadowRuntimeService
});
