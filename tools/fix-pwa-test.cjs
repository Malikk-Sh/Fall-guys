'use strict';
const fs = require('fs');
const file = 'server/pwa.test.mjs';
const source = fs.readFileSync(file, 'utf8');
const lines = source.split('\n').map(line =>
  line.includes('assert.match(source, /NETWORK_ONLY_PREFIXES')
    ? "  assert.ok(source.includes(\"const NETWORK_ONLY_PREFIXES = ['/api/', '/account', '/health', '/metrics', '/ws'];\"));"
    : line
);
fs.writeFileSync(file, lines.join('\n'));
