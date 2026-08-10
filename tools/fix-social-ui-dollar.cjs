'use strict';

const fs = require('fs');
const path = 'client/ui/UI.js';
let source = fs.readFileSync(path, 'utf8');
const broken =
  'const $ = selector => document.querySelector(selector);\nconst $ = selector => [...document.querySelectorAll(selector)];';
const fixed =
  'const $ = selector => document.querySelector(selector);\nconst ' +
  '$' +
  '$' +
  ' = selector => [...document.querySelectorAll(selector)];';
if (source.includes(broken)) {
  source = source.replace(broken, fixed);
  fs.writeFileSync(path, source);
  console.log('repaired UI query-all helper');
} else {
  console.log('UI query-all helper already correct');
}
