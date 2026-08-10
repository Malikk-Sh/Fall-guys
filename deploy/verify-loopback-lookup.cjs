'use strict';

const assert = require('node:assert/strict');
const loopbackLookup = require('./loopbackLookup.cjs');

let singleChecked = false;
loopbackLookup('wobbles.ru', {}, (error, address, family) => {
  assert.equal(error, null);
  assert.equal(address, '127.0.0.1');
  assert.equal(family, 4);
  singleChecked = true;
});
assert.equal(singleChecked, true);

let allChecked = false;
loopbackLookup('wobbles.ru', { all: true }, (error, addresses) => {
  assert.equal(error, null);
  assert.deepEqual(addresses, [{ address: '127.0.0.1', family: 4 }]);
  allChecked = true;
});
assert.equal(allChecked, true);

console.log('shared-443 loopback lookup: ok');
