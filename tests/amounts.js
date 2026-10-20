'use strict';
const assert = require('assert');
const path = require('path');
const code = require('esbuild').buildSync({ stdin: {contents:"export { amountUnits } from './engine/amount.js'; export { cleanAmount, maxAmount } from './web/lib/format.ts';", resolveDir:path.resolve('.')},bundle:true,platform:'node',format:'cjs',write:false }).outputFiles[0].text;
const box = {exports:{}}; new Function('module','exports',code)(box,box.exports);
const {amountUnits,cleanAmount,maxAmount}=box.exports;
assert.strictEqual(amountUnits(1e-9,9),1n);
assert.strictEqual(amountUnits('1.23456789e-3',9),1234567n);
assert.strictEqual(amountUnits('12345678901234567890.123456',6),12345678901234567890123456n);
assert.strictEqual(amountUnits(-1.5,6),-1500000n);
for(const input of ['NaN','Infinity','1e100000','1.2.3','']) assert.throws(()=>amountUnits(input,9));
assert.deepStrictEqual(cleanAmount('1.2.3.4'),{text:'1.234',value:1.234});
assert.strictEqual(cleanAmount('9'.repeat(400)).value,0);
for(const b of [0.123456789,99.9999999,123.456789,1e-9,1e21]) {
 const text=maxAmount(b); assert.ok(!/[e,]/i.test(text)); assert.strictEqual(Number(text),b);
 assert.strictEqual(amountUnits(text,9),amountUnits(b,9));
}
assert.strictEqual(maxAmount(Infinity),'');
console.log('ok - exact scientific and decimal amounts, invalid input, and Max balance round trips');
