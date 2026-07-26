const test=require('node:test'); const assert=require('node:assert/strict'); const {safeName}=require('./index');
test('player names are sanitized and limited',()=>{assert.equal(safeName('<b>Ada</b>'),'bAdab');assert.equal(safeName('x'.repeat(40)).length,16)});
