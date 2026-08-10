'use strict';
const fs = require('fs');
const file = 'server/pwa.test.mjs';
const source = fs.readFileSync(file, 'utf8');
const lines = source.split('\n').map(line => {
  if (line.includes('assert.match(source, /NETWORK_ONLY_PREFIXES')) {
    return "  assert.ok(source.includes(\"const NETWORK_ONLY_PREFIXES = ['/api/', '/account', '/health', '/metrics', '/ws'];\"));";
  }
  if (line.includes("assert.match(source, /event.data?.type === 'SKIP_WAITING'/)")) {
    return "  assert.ok(source.includes(\"event.data?.type === 'SKIP_WAITING'\"));";
  }
  return line;
});
fs.writeFileSync(file, lines.join('\n'));
