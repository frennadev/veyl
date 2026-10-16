// Node-side proving with snarkjs: the withdraw circuit (unchanged artifacts in zk/), Phase 2's transact and position and
// Phase 3's swap and claim circuits (the browser does the same in a Web Worker with window.snarkjs).
'use strict';
const path = require('path');
const snarkjs = require('snarkjs');
const { packProof } = require('./veyl.js');
const WASM = path.join(__dirname, '../zk/build/withdraw.wasm');
const ZKEY = path.join(__dirname, '../zk/keys/withdraw_final.zkey');
const VKEY = path.join(__dirname, '../zk/keys/withdraw_vkey.json');
/// Full Groth16 proof for the withdraw circuit. Takes ~5-30 s in Node. Returns the packed 256-byte proof and the 6 signals.
async function prove(input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  return { ...packProof(proof, publicSignals), raw: { proof, publicSignals } };
}
async function verifyLocal(raw) { return snarkjs.groth16.verify(require(VKEY), raw.publicSignals, raw.proof); }

/// Phase 2 / 3 circuits: zk/build/<name>.wasm, zk/keys/<name>_final.zkey, zk/keys/<name>_vkey.json. 8 public signals each,
/// except claim (6, padded with two zeros: what post_proof stores).
const CIRCUITS = Object.fromEntries(['transact', 'position', 'swap', 'claim'].map((n) => [n, { wasm: path.join(__dirname, '../zk/build/' + n + '.wasm'), zkey: path.join(__dirname, '../zk/keys/' + n + '_final.zkey'), vkey: path.join(__dirname, '../zk/keys/' + n + '_vkey.json') }]));
const NPUB = { transact: 8, position: 8, swap: 8, claim: 6 };
const TIMES = { transact: [], position: [], swap: [], claim: [] };
async function proveCircuit(name, input, keys = CIRCUITS[name]) {
  const { packProofN } = require('./shield.js');
  const t = Date.now(); const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, keys.wasm, keys.zkey); TIMES[name].push(Date.now() - t);
  const packed = packProofN(proof, publicSignals, NPUB[name]); while (packed.pubs.length < 8) packed.pubs.push(0n);
  return { ...packed, raw: { proof, publicSignals }, ms: Date.now() - t };
}
const proveTransact = (input, keys) => proveCircuit('transact', input, keys);
const provePosition = (input, keys) => proveCircuit('position', input, keys);
const proveSwap = (input, keys) => proveCircuit('swap', input, keys);
const proveClaim = (input, keys) => proveCircuit('claim', input, keys);
async function verifyCircuit(name, raw) { return snarkjs.groth16.verify(require(CIRCUITS[name].vkey), raw.publicSignals, raw.proof); }
module.exports = { prove, verifyLocal, WASM, ZKEY, VKEY, CIRCUITS, TIMES, proveTransact, provePosition, proveSwap, proveClaim, proveCircuit, verifyCircuit };
