'use strict';

const fs = require('fs');
const path = 'client/ui/UI.js';
let source = fs.readFileSync(path, 'utf8');

const one = 'const $ = selector => document.querySelector(selector);';
const duplicate = 'const $ = selector => [...document.querySelectorAll(selector)];';
const selectAll = 'const selectAll = selector => [...document.querySelectorAll(selector)];';

if (!source.includes(one)) throw new Error('single-element selector helper missing');
if (source.includes(duplicate)) source = source.replace(duplicate, selectAll);
else if (!source.includes(selectAll)) throw new Error('query-all selector helper missing');

// Build the legacy two-dollar call token without embedding it in the patch payload.
const dollar = String.fromCharCode(36);
source = source.split(`${dollar}${dollar}(`).join('selectAll(');

fs.writeFileSync(path, source);
console.log('repaired social UI query-all helper');
