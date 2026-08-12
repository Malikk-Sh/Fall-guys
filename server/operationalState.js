'use strict';

// Process-wide operational admission state shared by bootstrap and the game protocol.
// Once drain starts it is intentionally irreversible: this process is on its way out and
// systemd will replace it with a fresh process whose module state starts clean.
let draining = false;

function beginDrain() {
  if (draining) return false;
  draining = true;
  return true;
}

function isDraining() {
  return draining;
}

module.exports = { beginDrain, isDraining };
