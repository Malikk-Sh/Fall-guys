'use strict';

// Продуктовые счётчики воронки. Имена фиксированы намеренно: счётчик с произвольным ключом рано
// или поздно получил бы туда имя игрока или идентификатор сессии, а это уже персональные данные в
// том, что отдаётся в /health.
const PRODUCT_EVENT_NAMES = Object.freeze([
  'roomCreated',
  'roomJoined',
  'matchmakingStarted',
  'matchmakingMatched',
  'matchStarted',
  'checkpointReached',
  'playerDowned',
  'matchCompleted',
  'matchAbandoned',
  'connectionRecovered'
]);

function createEventCounters() {
  return Object.fromEntries(PRODUCT_EVENT_NAMES.map(name => [name, 0]));
}

function trackEvent(counters, name, amount = 1) {
  if (!Object.hasOwn(counters, name) || !Number.isSafeInteger(amount) || amount < 1) return false;
  counters[name] += amount;
  return true;
}

module.exports = Object.freeze({ PRODUCT_EVENT_NAMES, createEventCounters, trackEvent });
