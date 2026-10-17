// What each kind of request costs the relayer, the request kinds, and parsing helpers shared by the relayer modules.
'use strict';
const { ComputeBudgetProgram } = require('@solana/web3.js');
const { big, SIZES, rentOf } = require('../sdk/veyl.js');
/// A shielded liquidity action needs more than the default 32 KB heap (veyl_entry's allocator allows 256 KB when asked).
const HEAP = () => ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 });
const TX_FEE = 5000; // lamports per signature (the relayer signs every transaction alone)
/// What each kind of request leaves the relayer paying at most, in lamports (rent it never gets back + fees). Published in
/// /info so the app can pick a fee that covers it; /submit checks the exact cost of each request (REVIEW.md M-1).
const WORST = {
  relay: rentOf(SIZES.spend) + rentOf(SIZES.tokenAccount) + 2 * TX_FEE,                                             // spent marker + recipient token account
  swap: rentOf(SIZES.spend) + Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + 2 * TX_FEE,       // + the output note's record (or a token account)
  add: rentOf(SIZES.spend) + rentOf(SIZES.shares) + 3 * TX_FEE,                                                      // per leg + one share account
  remove: rentOf(SIZES.nonce) + 2 * Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + TX_FEE,    // nonce + two output records
  claim: rentOf(SIZES.nonce) + 2 * Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + TX_FEE,     // as remove
  orderWithdraw: rentOf(SIZES.nonce) + 2 * Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + TX_FEE,
  reward: rentOf(SIZES.nonce) + Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + TX_FEE,         // one output
  order: rentOf(SIZES.spend) + rentOf(SIZES.shares) + rentOf(SIZES.binArray) + 3 * TX_FEE,                           // spend + share account + bin array
  zap: rentOf(SIZES.spend) + 2 * (rentOf(SIZES.shares) + rentOf(SIZES.binArray)) + 3 * TX_FEE,                       // up to two new chunks
  rebalance: rentOf(SIZES.nonce) + 2 * (rentOf(SIZES.shares) + rentOf(SIZES.binArray)) + 2 * Math.max(rentOf(SIZES.depositRecord), rentOf(SIZES.tokenAccount)) + 2 * TX_FEE,
  // Phase 2: a nullifier PDA (rent never returned) per spent note; posted proofs and request buffers are refunded on execution
  transact: 2 * rentOf(0) + rentOf(SIZES.tokenAccount) + 2 * TX_FEE,
  shieldSwap: 2 * rentOf(0) + 5 * TX_FEE,
  shieldOrder: 2 * rentOf(0) + rentOf(SIZES.shares) + rentOf(SIZES.binArray) + 5 * TX_FEE,
  shieldOrderWithdraw: 2 * rentOf(0) + 5 * TX_FEE,
  shieldLp: 5 * rentOf(0) + 2 * (rentOf(SIZES.shares) + rentOf(SIZES.binArray) + rentOf(SIZES.lpAcc)) + 8 * TX_FEE,
  migrate: rentOf(SIZES.spend) + 2 * TX_FEE,
  // Phase 3: two nullifiers (a swap) / one (a claim); the posted proof's rent comes back on execution
  sealedSwap: 2 * rentOf(0) + 2 * TX_FEE,
  sealedClaim: rentOf(0) + 2 * TX_FEE,
};
const SIGNED = new Set(['remove', 'claim', 'reward', 'orderWithdraw', 'rebalance']);
const SHIELD_KINDS = new Set(['transact', 'shieldLp', 'shieldSwap', 'shieldOrder', 'shieldOrderWithdraw', 'migrate', 'sealedSwap', 'sealedClaim']);
const PROOF_LEGS = new Set(['add', 'order', 'zap']);
/// USD prices for the fee floor: deploy.<network>.json token prices, overridden by PRICES_JSON='{"SOL":150,"USDC":1}'.
function pricesFrom(dep, env = process.env) { const out = {}; for (const [sym, t] of Object.entries(dep.tokens || {})) if (typeof t.price === 'number' && t.price > 0) out[sym] = t.price;
  if (env.PRICES_JSON) Object.assign(out, JSON.parse(env.PRICES_JSON)); return out; }

/// Numbers sent as decimal strings back to BigInt. The default public key ("111...1", 32 ones) is all digits too: kept as is.
const DEFAULT_B58 = '11111111111111111111111111111111';
function deepBig(o) { if (Array.isArray(o)) return o.map(deepBig); if (o && typeof o === 'object') return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deepBig(v)])); return o === DEFAULT_B58 ? o : big(o); }
module.exports = { HEAP, TX_FEE, WORST, SIGNED, SHIELD_KINDS, PROOF_LEGS, pricesFrom, deepBig };
