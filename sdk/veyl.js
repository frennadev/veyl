// Veyl SDK for Solana. Plain @solana/web3.js + @solana/spl-token; hand-built Anchor instruction encoders
// (8-byte discriminators = sha256("global:<ix>")[0..8]), PDA helpers, account decoders, event parsing, the exact
// JavaScript twin of the bin-pool maths (quotes), and the note / Merkle helpers the prover needs.
// Works in Node and (bundled) in the browser.
'use strict';
const { Buffer } = require('buffer');
const { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Ed25519Program, AddressLookupTableProgram, AddressLookupTableAccount, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const { sha256 } = require('js-sha256');
const { poseidon1, poseidon2, poseidon3 } = require('poseidon-lite');

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYS = SystemProgram.programId;
const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
/// Account sizes (bytes, discriminator included) of what the programs create: for rent estimates (the relayer's fee floor).
const SIZES = { spend: 250, depositRecord: 145, nonce: 48, shares: 6864, binArray: 9664, binPool: 1256, factory: 428, bond: 97, tokenAccount: 165, lpAcc: 1968, posted: 306, pending: 153 };
/// Rent-exempt minimum, the runtime's formula: (128 + bytes) x 3480 lamports/byte-year x 2 years.
const rentOf = (bytes) => (128 + bytes) * 6960;
const F = 21888242871839275222246405745257275088548364400416034343698204186575808495617n; // BN254 scalar field
const Q = 1n << 128n;
const STATE_DEPTH = 32, ASP_DEPTH = 20; // = Withdraw(32, 20) in zk/circuits/withdraw.circom
const ROOT_HISTORY = 192, ASP_HISTORY = 16, BINS_PER_ARRAY = 60;
const CHUNKS = 2048, MIN_CHUNK = -1024, BITMAP_WORDS = 32, MIN_BIN_ID = -1024 * 60, MAX_BIN_ID = (2048 - 1024) * 60 - 1;
const MAX_IDS = 70, BPS = 10_000n, PROTOCOL_FEE_BPS = 20, MAX_TIERS = 16, NUM_REWARDS = 2, SWAP_ARRAYS = 4;
/// Suggested fee tiers (Orca / Raydium-like; the deploy config owns the real list, `add_fee_tier` in this order). baseFee in
/// pips (1e-6: 100 = 0.01%), one bin step per tier (the pool address includes it). vfc scaled ~1/binStep^2 above bin step 20
/// so one bin of movement adds a similar variable fee in every tier.
const DEFAULT_FEE_TIERS = [
  { label: 'Stable 0.01%', binStep: 1, baseFee: 100, vfc: 10_000 }, { label: 'Stable 0.05%', binStep: 5, baseFee: 500, vfc: 10_000 },
  { label: 'Major 0.05%', binStep: 10, baseFee: 500, vfc: 10_000 }, { label: 'Major 0.25%', binStep: 20, baseFee: 2_500, vfc: 10_000 },
  { label: 'Major 0.30%', binStep: 30, baseFee: 3_000, vfc: 4_500 }, { label: 'Volatile 0.5%', binStep: 50, baseFee: 5_000, vfc: 1_600 },
  { label: 'Volatile 1%', binStep: 80, baseFee: 10_000, vfc: 625 },
  { label: 'Volatile 2%', binStep: 100, baseFee: 20_000, vfc: 400 }];
const U128 = 1n << 128n, U64MAX = (1n << 64n) - 1n;
const PIPS = 1_000_000n, MAX_FEE = 100_000n, FILTER_PERIOD = 30n, DECAY_PERIOD = 600n, REDUCTION_BPS = 5_000n, MAX_VOL_ACC = 350_000n, MAX_STEPS = 256, MIN_LIQUIDITY = 1_000n;
const MAX_FEE_BPS = 100;
const ACTION = { RELAY: 1, SWAP: 2, ADD: 3, ORDER: 4, ZAP: 5 };
/// Domain tags of what a position's one-time key signs (veyl_entry TAG_*).
const TAGS = { remove: 'veyl-remove-v1', claim: 'veyl-claim-v1', reward: 'veyl-reward-v1', orderWithdraw: 'veyl-order-v1', rebalance: 'veyl-rebalance-v1' };
/// Meteora's variable_fee_control (fee denominator 1e9, (va*binStep)^2 * vfc / 1e11, ceiling) = 100 x Veyl's (pips, / 1e12, floor).
const vfcFromMeteora = (m) => BigInt(m) / 100n; const vfcToMeteora = (v) => BigInt(v) * 100n;
const DEFAULT_TTL_SLOTS = 1500; // ~10 minutes for a posted proof to be executed

// ------------------------------------------------------------------------------------------------ bytes
const disc = (name, ns = 'global') => Buffer.from(sha256.arrayBuffer(ns + ':' + name)).subarray(0, 8);
const u8 = (n) => Buffer.from([Number(n) & 0xff]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(Number(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n)); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(Number(n)); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u128 = (n) => { const b = Buffer.alloc(16); const v = BigInt(n); b.writeBigUInt64LE(v & ((1n << 64n) - 1n)); b.writeBigUInt64LE(v >> 64n, 8); return b; };
const pk = (k) => new PublicKey(k).toBuffer();
const opt = (v, enc) => (v === null || v === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), enc(v)]));
const vec = (xs, enc) => Buffer.concat([u32(xs.length), ...xs.map(enc)]);
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };
/// A field element / 256-bit number as 32 big-endian bytes (what the circuit's public signals and the program use).
const be32 = (x) => { const h = BigInt(x).toString(16).padStart(64, '0'); return Buffer.from(h, 'hex'); };
const fromBe32 = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const W = (pubkey, isSigner = false) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable: true });
const R = (pubkey, isSigner = false) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable: false });
const big = (x) => (typeof x === 'string' && /^\d+$/.test(x) ? BigInt(x) : x);
const j = (o) => JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

class Reader { constructor(d) { this.d = Buffer.from(d); this.o = 0; }
  pk() { const v = new PublicKey(this.d.subarray(this.o, this.o + 32)); this.o += 32; return v; }
  u8() { return this.d[this.o++]; } bool() { return this.d[this.o++] === 1; }
  u16() { const v = this.d.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.d.readUInt32LE(this.o); this.o += 4; return v; } i32() { const v = this.d.readInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.d.readBigUInt64LE(this.o); this.o += 8; return v; } i64() { const v = this.d.readBigInt64LE(this.o); this.o += 8; return v; }
  u128() { const lo = this.u64(); const hi = this.u64(); return lo + (hi << 64n); }
  bytes(n) { const v = Buffer.from(this.d.subarray(this.o, this.o + n)); this.o += n; return v; }
  be32() { return fromBe32(this.bytes(32)); }
  str() { const n = this.u32(); return this.bytes(n).toString('utf8'); }
  vec(f) { const n = this.u32(); const out = []; for (let i = 0; i < n; i++) out.push(f()); return out; }
  skip(n) { this.o += n; } }

// ------------------------------------------------------------------------------------------------ hashing (must match the programs)
const H = (...xs) => { const a = xs.map(BigInt); return a.length === 1 ? poseidon1(a) : a.length === 2 ? poseidon2(a) : poseidon3(a); };
const hashToField = (...parts) => { const h = Buffer.from(sha256.arrayBuffer(Buffer.concat(parts.map((p) => Buffer.from(p))))); h[0] &= 0x1f; return fromBe32(h); };
const labelOf = (pool, nonce) => hashToField(Buffer.from('veyl-label'), pk(pool), u64(nonce));
const contextOf = (processor, data, pool) => hashToField(Buffer.from('veyl-context'), pk(processor), data, pk(pool));
const rand = () => { const b = new Uint8Array(32); (globalThis.crypto || require('crypto').webcrypto).getRandomValues(b); return (fromBe32(b) % (F - 1n)) + 1n; };
function zeros(depth) { const z = [0n]; for (let i = 1; i <= depth; i++) z.push(H(z[i - 1], z[i - 1])); return z; }
/// Root and sibling path of leaf `index` in a fixed-depth tree with empty leaves = 0 (same as the circuit's MerkleRoot).
function merklePath(leaves, index, depth) {
  const z = zeros(depth); let level = leaves.map(BigInt), idx = index; const siblings = [];
  for (let d = 0; d < depth; d++) {
    const sib = idx ^ 1; siblings.push(sib < level.length ? level[sib] : z[d]);
    const next = []; for (let i = 0; i < level.length; i += 2) next.push(H(level[i], i + 1 < level.length ? level[i + 1] : z[d]));
    level = next; idx >>= 1;
  }
  return { root: level.length ? level[0] : z[depth], siblings };
}
/// snarkjs proof -> the 256 bytes the program takes (A | B with c1 before c0 | C), and the 6 public signals as 32-byte BE each.
function packProofN(proof, publicSignals, n) {
  const B = (x) => be32(BigInt(x));
  if (publicSignals.length !== n) throw new Error('expected ' + n + ' public signals, got ' + publicSignals.length);
  return { proof: Buffer.concat([B(proof.pi_a[0]), B(proof.pi_a[1]), B(proof.pi_b[0][1]), B(proof.pi_b[0][0]), B(proof.pi_b[1][1]), B(proof.pi_b[1][0]), B(proof.pi_c[0]), B(proof.pi_c[1])]), pubs: publicSignals.map((s) => BigInt(s)) };
}
const packProof = (proof, publicSignals) => packProofN(proof, publicSignals, 6); // the withdraw circuit
/// BigInts as decimal strings (witness inputs for snarkjs, JSON for the relayer)
const strings = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

/// The circuit's input for spending `withdrawnValue` out of `note` (value, label, nullifier, secret, index) under `context`,
/// given the pool's leaves and the approved labels. Returns the input and the change note's fresh secrets.
function withdrawInput({ note, withdrawnValue, context, leaves, labels }) {
  const aspIndex = labels.map(String).indexOf(String(note.label));
  if (aspIndex < 0) throw new Error('label not approved');
  const st = merklePath(leaves, Number(note.index), STATE_DEPTH); const asp = merklePath(labels, aspIndex, ASP_DEPTH);
  if (st.siblings.length !== STATE_DEPTH) throw new Error('bad state path');
  const newNullifier = rand(), newSecret = rand();
  const input = { withdrawnValue: BigInt(withdrawnValue).toString(), stateRoot: st.root.toString(), aspRoot: asp.root.toString(), context: BigInt(context).toString(), label: String(note.label),
    existingValue: String(note.value), existingNullifier: String(note.nullifier), existingSecret: String(note.secret), newNullifier: newNullifier.toString(), newSecret: newSecret.toString(),
    stateIndex: String(note.index), stateSiblings: st.siblings.map(String), aspIndex: String(aspIndex), aspSiblings: asp.siblings.map(String) };
  const change = BigInt(note.value) - BigInt(withdrawnValue);
  const changeNote = { value: change.toString(), label: String(note.label), nullifier: newNullifier.toString(), secret: newSecret.toString(), precommitment: H(newNullifier, newSecret).toString(), commitment: H(change, BigInt(note.label), H(newNullifier, newSecret)).toString() };
  return { input, changeNote, stateRoot: st.root, aspRoot: asp.root };
}
/// A fresh note's secrets: nullifier, secret and precommitment = Poseidon(nullifier, secret).
function newNote() { const nullifier = rand(), secret = rand(); return { nullifier: nullifier.toString(), secret: secret.toString(), precommitment: H(nullifier, secret).toString() }; }

/// The smallest fee (bps) on `value` that pays at least `minAtoms`, never below `floorBps`; null when even `capBps` cannot.
function feeBpsFor(value, minAtoms, floorBps, capBps = MAX_FEE_BPS) {
  const v = BigInt(value), m = BigInt(minAtoms || 0); let bps = Number(floorBps);
  if (m > 0n) { if (v <= 0n) return null; const need = Number((m * 10_000n + v - 1n) / v); if (need > bps) bps = need; }
  return bps <= capBps ? bps : null;
}

// ------------------------------------------------------------------------------------------------ action data (borsh, = the Rust structs)
const encHop = (h) => Buffer.concat([pk(h.pool), u8(h.xForY ? 1 : 0), u8(h.nArrays || 0)]);
const encRoute = (r) => Buffer.concat([u64(r.amountIn), vec(r.hops, encHop)]);
const DATA = {
  relay: (d) => Buffer.concat([pk(d.recipient), pk(d.feeRecipient), u16(d.feeBps), i64(d.deadline)]),
  swap: (d) => Buffer.concat([pk(d.tokenOut), vec(d.routes, encRoute), u64(d.minOut), opt(d.recipient, pk), be32(d.outPrecommitment), pk(d.refundTo), pk(d.feeRecipient), u16(d.feeBps), i64(d.deadline)]),
  add: (d) => Buffer.concat([pk(d.binPool), vec(d.ids, i32), vec(d.amountsX, u64), vec(d.amountsY, u64), vec(d.minShares || [], u128), pk(d.owner), pk(d.feeRecipient), u16(d.feeBps), i64(d.deadline)]),
  remove: (d) => Buffer.concat([pk(d.owner), pk(d.binPool), vec(d.ids, i32), vec(d.shares, u128), be32(d.precommitX), be32(d.precommitY), opt(d.recipient, pk), pk(d.feeRecipient), u16(d.feeBps), u64(d.nonce), i64(d.deadline)]),
  claim: (d) => Buffer.concat([pk(d.owner), pk(d.binPool), vec(d.ids, i32), be32(d.precommitX), be32(d.precommitY), opt(d.recipient, pk), pk(d.feeRecipient), u16(d.feeBps), u64(d.nonce), i64(d.deadline)]),
  reward: (d) => Buffer.concat([pk(d.owner), pk(d.binPool), u8(d.index), vec(d.ids, i32), be32(d.precommit), opt(d.recipient, pk), pk(d.feeRecipient), u16(d.feeBps), u64(d.nonce), i64(d.deadline)]),
  order: (d) => Buffer.concat([pk(d.binPool), i32(d.id), u8(d.isAsk ? 1 : 0), pk(d.owner), pk(d.feeRecipient), u16(d.feeBps), i64(d.deadline)]),
  orderWithdraw: (d) => Buffer.concat([pk(d.owner), pk(d.binPool), i32(d.id), u8(d.isAsk ? 1 : 0), u128(d.shares), be32(d.precommitX), be32(d.precommitY), opt(d.recipient, pk), pk(d.feeRecipient), u16(d.feeBps), u64(d.nonce), i64(d.deadline)]),
  rebalance: (d) => Buffer.concat([pk(d.owner), pk(d.binPool), vec(d.burnIds, i32), vec(d.burnShares, u128), vec(d.ids, i32), vec(d.weightsX, u16), vec(d.weightsY, u16), vec(d.minShares || [], u128), be32(d.precommitX), be32(d.precommitY), opt(d.recipient, pk), pk(d.feeRecipient), u16(d.feeBps), u64(d.nonce), i64(d.deadline)]),
  zap: (d) => Buffer.concat([pk(d.binPool), u8(d.xIn ? 1 : 0), u64(d.swapAmount), u64(d.minSwapOut), vec(d.ids, i32), vec(d.weightsX, u16), vec(d.weightsY, u16), vec(d.minShares || [], u128), pk(d.owner), pk(d.feeRecipient), u16(d.feeBps), i64(d.deadline)]),
};
/// The bytes the pool hashes into a proof's context: action tag + borsh(data).
const encodeAction = (kind, d) => Buffer.concat([u8(ACTION[kind.toUpperCase()]), DATA[kind](d)]);
/// What a one-time key signs to remove its position: sha256("veyl-remove-v1" || entry program id || borsh(RemoveData)).
const removeDigest = (entryProgram, d) => signedDigest('remove', entryProgram, d);
/// What a one-time key signs for a position action `kind` (remove | claim | reward | orderWithdraw | rebalance):
/// sha256(tag || entry program id || borsh(data)).
const signedDigest = (kind, entryProgram, d) => Buffer.from(sha256.arrayBuffer(Buffer.concat([Buffer.from(TAGS[kind]), pk(entryProgram), DATA[kind](d)])));

// ------------------------------------------------------------------------------------------------ events
const EVENTS = {
  Deposited: (r) => ({ pool: r.pk(), beneficiary: r.pk(), payer: r.pk(), commitment: r.be32(), label: r.be32(), value: r.u64(), precommitment: r.be32(), index: r.u64() }),
  Posted: (r) => ({ pool: r.pk(), nullifierHash: r.be32(), processor: r.pk(), value: r.u64(), expiresAt: r.u64() }),
  Withdrawn: (r) => ({ pool: r.pk(), processor: r.pk(), value: r.u64(), nullifierHash: r.be32(), newCommitment: r.be32(), index: r.u64() }),
  RagequitEvent: (r) => ({ pool: r.pk(), depositor: r.pk(), label: r.be32(), value: r.u64() }),
  AspRootUpdated: (r) => ({ pool: r.pk(), root: r.be32(), ipfsCid: r.str() }),
  PostmanUpdated: (r) => ({ pool: r.pk(), postman: r.pk() }),
  PoolCreated: (r) => ({ pool: r.pk(), mintX: r.pk(), mintY: r.pk(), binStep: r.u16(), baseFee: r.u32(), tier: r.u8(), creator: r.pk(), bond: r.u64(), unlockAt: r.i64() }),
  FeeTierAdded: (r) => ({ index: r.u8(), binStep: r.u16(), baseFee: r.u32(), vfc: r.u64() }),
  FeeTierSet: (r) => ({ index: r.u8(), enabled: r.bool() }),
  BondSet: (r) => ({ lamports: r.u64(), lockSeconds: r.i64() }),
  TreasurySet: (r) => ({ treasury: r.pk() }),
  BondReleased: (r) => ({ pool: r.pk(), creator: r.pk(), amount: r.u64() }),
  PoolDelisted: (r) => ({ pool: r.pk(), forfeited: r.u64() }),
  ProtocolFeePaid: (r) => ({ pool: r.pk(), sender: r.pk(), amountX: r.u64(), amountY: r.u64() }),
  Minted: (r) => ({ pool: r.pk(), sender: r.pk(), owner: r.pk(), ids: r.vec(() => r.i32()), amountsX: r.vec(() => r.u64()), amountsY: r.vec(() => r.u64()), shares: r.vec(() => r.u128()) }),
  Burned: (r) => ({ pool: r.pk(), authority: r.pk(), owner: r.pk(), ids: r.vec(() => r.i32()), shares: r.vec(() => r.u128()), amountX: r.u64(), amountY: r.u64() }),
  Swapped: (r) => ({ pool: r.pk(), sender: r.pk(), to: r.pk(), xForY: r.bool(), amountIn: r.u64(), amountOut: r.u64(), fee: r.u64(), activeId: r.i32(), protocolFee: r.u64() }),
  FeesClaimed: (r) => ({ pool: r.pk(), authority: r.pk(), owner: r.pk(), ids: r.vec(() => r.i32()), amountX: r.u64(), amountY: r.u64() }),
  RewardClaimed: (r) => ({ pool: r.pk(), authority: r.pk(), owner: r.pk(), index: r.u8(), ids: r.vec(() => r.i32()), amount: r.u64() }),
  LimitOrderPlaced: (r) => ({ pool: r.pk(), sender: r.pk(), owner: r.pk(), id: r.i32(), isAsk: r.bool(), amount: r.u64(), shares: r.u128() }),
  LimitOrderWithdrawn: (r) => ({ pool: r.pk(), authority: r.pk(), owner: r.pk(), id: r.i32(), isAsk: r.bool(), shares: r.u128(), amountX: r.u64(), amountY: r.u64(), unfilledLeft: r.u64() }),
  Rebalanced: (r) => ({ pool: r.pk(), authority: r.pk(), owner: r.pk(), burnedX: r.u64(), burnedY: r.u64(), withheldX: r.u64(), withheldY: r.u64(), readdedX: r.u64(), readdedY: r.u64(), ids: r.vec(() => r.i32()), shares: r.vec(() => r.u128()) }),
  ZapAdded: (r) => ({ pool: r.pk(), sender: r.pk(), owner: r.pk(), xIn: r.bool(), amountIn: r.u64(), swapAmount: r.u64(), swapOut: r.u64(), ids: r.vec(() => r.i32()), shares: r.vec(() => r.u128()) }),
  ProtocolFeeWithdrawn: (r) => ({ pool: r.pk(), toX: r.pk(), toY: r.pk(), amountX: r.u64(), amountY: r.u64() }),
  FeeAuthoritySet: (r) => ({ feeAuthority: r.pk() }),
  RewardInitialized: (r) => ({ pool: r.pk(), index: r.u8(), mint: r.pk(), funder: r.pk(), duration: r.u64() }),
  RewardFunded: (r) => ({ pool: r.pk(), index: r.u8(), amount: r.u64(), rateQ64: r.u128(), end: r.i64() }),
  RewardFunderSet: (r) => ({ pool: r.pk(), index: r.u8(), funder: r.pk() }),
  IneligibleRewardWithdrawn: (r) => ({ pool: r.pk(), index: r.u8(), amount: r.u64() }),
  Relayed: (r) => ({ pool: r.pk(), recipient: r.pk(), value: r.u64(), fee: r.u64() }),
  PrivateSwapped: (r) => ({ tokenIn: r.pk(), tokenOut: r.pk(), amountIn: r.u64(), amountOut: r.u64(), fee: r.u64() }),
  PrivateAdded: (r) => ({ owner: r.pk(), binPool: r.pk(), ids: r.vec(() => r.i32()), shares: r.vec(() => r.u128()) }),
  PrivateRemoved: (r) => ({ owner: r.pk(), binPool: r.pk(), amountX: r.u64(), amountY: r.u64() }),
  PrivateFeesClaimed: (r) => ({ owner: r.pk(), binPool: r.pk(), amountX: r.u64(), amountY: r.u64() }),
  PrivateRewardClaimed: (r) => ({ owner: r.pk(), binPool: r.pk(), index: r.u8(), amount: r.u64() }),
  PrivateOrderPlaced: (r) => ({ owner: r.pk(), binPool: r.pk(), id: r.i32(), isAsk: r.bool(), amount: r.u64(), shares: r.u128() }),
  PrivateOrderWithdrawn: (r) => ({ owner: r.pk(), binPool: r.pk(), id: r.i32(), isAsk: r.bool(), amountX: r.u64(), amountY: r.u64() }),
  PrivateRebalanced: (r) => ({ owner: r.pk(), binPool: r.pk(), burnedX: r.u64(), burnedY: r.u64(), readdedX: r.u64(), readdedY: r.u64(), feeX: r.u64(), feeY: r.u64() }),
  PrivateZapped: (r) => ({ owner: r.pk(), binPool: r.pk(), xIn: r.bool(), amountIn: r.u64(), swapAmount: r.u64(), ids: r.vec(() => r.i32()), shares: r.vec(() => r.u128()) }),
  Routed: (r) => ({ sender: r.pk(), tokenIn: r.pk(), tokenOut: r.pk(), amountIn: r.u64(), amountOut: r.u64(), routes: r.u8() }),
  // Phase 2 (veyl_pool shielded pool, veyl_bin, veyl_entry shielded actions)
  ShieldPostmanUpdated: (r) => ({ postman: r.pk() }),
  ProofPosted: (r) => ({ id: r.bytes(32), kind: r.u8(), expiresAt: r.u64() }),
  NoteInserted: (r) => ({ index: r.u64(), commitment: r.be32() }),
  NoteCiphertext: (r) => ({ commitment: r.be32(), data: r.bytes(r.u32()) }),
  ReceiptNote: (r) => ({ index: r.u64(), commitment: r.be32(), asset: r.be32(), amount: r.u64(), owner: r.be32(), blinding: r.be32() }),
  Nullified: (r) => ({ nullifier: r.be32() }),
  Transacted: (r) => ({ nullifiers: [r.be32(), r.be32()], mint: r.pk(), extAmount: r.i64(), fee: r.u64() }),
  DepositPending: (r) => ({ pending: r.pk(), depositor: r.pk(), mint: r.pk(), amount: r.u64(), commitments: [r.be32(), r.be32()], nullifiers: [r.be32(), r.be32()] }),
  DepositApproved: (r) => ({ pending: r.pk(), indexes: [r.u64(), r.u64()] }),
  DepositCancelled: (r) => ({ pending: r.pk(), depositor: r.pk(), amount: r.u64() }),
  MintedExact: (r) => ({ pool: r.pk(), sender: r.pk(), owner: r.pk(), ids: r.vec(() => r.i32()), shares: r.vec(() => r.u128()), amountX: r.u64(), amountY: r.u64() }),
  PositionCiphertext: (r) => ({ commitment: r.be32(), data: r.bytes(r.u32()) }),
  ShieldLpExecuted: (r) => ({ binPool: r.pk(), lo: r.i32(), deltas: r.vec(() => { const v = r.u128(); return v >= (1n << 127n) ? v - (1n << 128n) : v; }), legs: r.u8(), charge: [r.u64(), r.u64()], pay: [r.u64(), r.u64()], claimFee: [r.u64(), r.u64()], leftoverFee: [r.u64(), r.u64()], receipts: [r.u64(), r.u64()], nullifier: r.be32(), diluted: [r.u8() === 1, r.u8() === 1] }),
  ShieldSwapped: (r) => ({ tokenIn: r.pk(), tokenOut: r.pk(), amountIn: r.u64(), amountOut: r.u64(), fee: r.u64() }),
  ShieldOrderPlaced: (r) => ({ binPool: r.pk(), id: r.i32(), isAsk: r.bool(), amount: r.u64(), shares: r.u128() }),
  ShieldOrderWithdrawn: (r) => ({ binPool: r.pk(), id: r.i32(), isAsk: r.bool(), amountX: r.u64(), amountY: r.u64() }),
  Migrated: (r) => ({ mint: r.pk(), amount: r.u64(), fee: r.u64() }),
  ShieldRewardsReturned: (r) => ({ binPool: r.pk(), index: r.u8(), amount: r.u64() }),
  // Phase 3 (sealed batch swaps, veyl_entry/src/sealed.rs)
  CommitteeSet: (r) => ({ epoch: r.u32(), t: r.u8(), n: r.u8(), kind: r.u8(), pk: r.bytes(64), transcript: r.bytes(32) }),
  BatchOpened: (r) => ({ binPool: r.pk(), seq: r.u64(), endSlot: r.u64() }),
  SealedSwapSubmitted: (r) => ({ binPool: r.pk(), seq: r.u64(), direction: r.u8(), count: [r.u32(), r.u32()] }),
  BatchRolled: (r) => ({ binPool: r.pk(), seq: r.u64(), endSlot: r.u64(), rollovers: r.u8(), count: [r.u32(), r.u32()] }),
  BatchClosed: (r) => ({ binPool: r.pk(), seq: r.u64(), count: [r.u32(), r.u32()], aggregates: [r.bytes(64), r.bytes(64), r.bytes(64), r.bytes(64)] }),
  BatchFailed: (r) => ({ binPool: r.pk(), seq: r.u64(), count: [r.u32(), r.u32()], reason: r.u8() }),
  SharePosted: (r) => ({ batch: r.pk(), member: r.u8() }),
  ShareVerified: (r) => ({ binPool: r.pk(), seq: r.u64(), member: r.u8() }),
  TotalVerified: (r) => ({ binPool: r.pk(), seq: r.u64(), direction: r.u8(), total: r.u64() }),
  BatchSettled: (r) => ({ binPool: r.pk(), seq: r.u64(), totals: [r.u64(), r.u64()], count: [r.u32(), r.u32()], xForY: r.bool(), netIn: r.u64(), netOut: r.u64(), activeId: r.i32(), price: r.be32(), num: [r.u64(), r.u64()], den: [r.u64(), r.u64()], protocolFee: r.o + 16 <= r.d.length ? [r.u64(), r.u64()] : null }),
  SealedClaimed: (r) => ({ binPool: r.pk(), seq: r.u64(), direction: r.u8(), refund: r.bool() }),
};
const EVENT_BY_DISC = Object.fromEntries(Object.keys(EVENTS).map((n) => [disc(n, 'event').toString('hex'), n]));
function parseEvents(logs) {
  const out = [];
  for (const l of logs || []) { if (!l.startsWith('Program data: ')) continue; let b; try { b = Buffer.from(l.slice(14), 'base64'); } catch { continue; }
    const name = EVENT_BY_DISC[b.subarray(0, 8).toString('hex')]; if (!name) continue; try { out.push({ name, ...EVENTS[name](new Reader(b.subarray(8))) }); } catch { /* not ours */ } }
  return out;
}
/// parseEvents, each event with the program whose frame logged it (`program`, base58; null when the logs have no invoke
/// lines). Any program can log a "Program data:" line that looks like one of ours, but only the runtime writes the
/// "Program <id> invoke [n]" / "Program <id> success|failed" lines that frame it.
function logEvents(logs) { const out = []; const stack = [];
  for (const l of logs || []) { let m;
    if ((m = /^Program (\w+) invoke \[\d+\]$/.exec(l))) stack.push(m[1]);
    else if (/^Program \w+ (success|failed)/.test(l)) stack.pop();
    else if (l.startsWith('Program data: ')) { const e = parseEvents([l])[0]; if (e) out.push({ ...e, program: stack.length ? stack[stack.length - 1] : null }); } }
  return out; }
/// Anchor's event-cpi instruction tag (EVENT_IX_TAG = 0x1d9acb512ea545e4, little-endian): a program's self-CPI whose data
/// starts with it carries events, signed by its event authority PDA ["__event_authority"] (veyl_pool: Evs).
const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');
/// The events of one event-cpi instruction's data after the tag: Anchor's encoding (8-byte discriminator sha256("event:<Name>")
/// + borsh) once per event, back to back (Anchor's emit_cpi! sends one; veyl_pool sends all of an instruction's at once).
function parseEventData(data) { const b = Buffer.from(data); const out = []; const r = new Reader(b);
  while (r.o + 8 <= b.length) { const name = EVENT_BY_DISC[b.subarray(r.o, r.o + 8).toString('hex')]; if (!name) break; r.o += 8; try { out.push({ name, ...EVENTS[name](r) }); } catch { break; } }
  return out; }

// ------------------------------------------------------------------------------------------------ bin maths (exact twin of programs/veyl_bin)
const mulDiv = (a, b, c) => (a * b) / c;
const mulDivCeil = (a, b, c) => { const p = a * b; return p / c + (p % c === 0n ? 0n : 1n); };
function stepQ(binStep) { return Q + (Q * BigInt(binStep)) / 10_000n; }
/// P(id) = basePrice * stepQ^id / Q, square-and-multiply with floor at each step like `_pow`.
function priceOf(basePrice, binStep, id) {
  const sq = stepQ(binStep); let n = BigInt(Math.abs(id)); let r = Q; let b = sq;
  for (;;) { if (n & 1n) r = mulDiv(r, b, Q); n >>= 1n; if (n === 0n) break; b = mulDiv(b, b, Q); }
  return id >= 0 ? mulDiv(BigInt(basePrice), r, Q) : mulDiv(BigInt(basePrice), Q, r);
}
const feeOf = (p, va) => { const v = va * BigInt(p.binStep); const f = BigInt(p.baseFee) + (v * v * BigInt(p.variableFeeControl)) / 1_000_000_000_000n; return f > MAX_FEE ? MAX_FEE : f; };
const accOf = (ref, iref, id) => { const dist = BigInt(Math.abs(iref - id)); const va = ref + dist * 10_000n; return va > MAX_VOL_ACC ? MAX_VOL_ACC : va; };
function refsOf(p, now) { const dt = BigInt(now) - BigInt(p.lastSwapAt); let ref = BigInt(p.volRef), iref = p.idRef; if (dt >= FILTER_PERIOD) { iref = p.activeId; ref = dt < DECAY_PERIOD ? (BigInt(p.volAcc) * REDUCTION_BPS) / 10_000n : 0n; } return { ref, iref }; }
const EMPTY_BIN = Object.freeze({ x: 0n, y: 0n, shares: 0n, feeGx: 0n, feeGy: 0n, rewardG: [0n, 0n], askShares: 0n, askX: 0n, askFilledY: 0n, bidShares: 0n, bidY: 0n, bidFilledX: 0n });
const hasX = (b) => b.x > 0n || (b.askX || 0n) > 0n; const hasY = (b) => b.y > 0n || (b.bidY || 0n) > 0n;
const chunkIdx = (c) => { const i = c - MIN_CHUNK; return i < 0 || i >= CHUNKS ? null : i; };
/// The pool's bin-array bitmap bit for a side (y = holds Y to sell).
function chunkBit(p, ySide, c) { const i = chunkIdx(c); if (i === null || !p.bitmapX) return false; const bm = ySide ? p.bitmapY : p.bitmapX; return ((bm[Math.floor(i / 64)] >> BigInt(i % 64)) & 1n) === 1n; }
/// The nearest bin array strictly beyond `c` in the direction whose bit is set (= BinPool::next_chunk).
function nextChunk(p, ySide, c, down) { const i0 = c - MIN_CHUNK;
  if (down) { for (let i = Math.min(i0 - 1, CHUNKS - 1); i >= 0; i--) if (chunkBit(p, ySide, i + MIN_CHUNK)) return i + MIN_CHUNK; }
  else { for (let i = Math.max(i0 + 1, 0); i < CHUNKS; i++) if (chunkBit(p, ySide, i + MIN_CHUNK)) return i + MIN_CHUNK; }
  return null; }
/// Every bin array whose bit is set on a side (for listing pools / liquidity charts).
function liveChunks(p, ySide) { const out = []; for (let i = 0; i < CHUNKS; i++) if (chunkBit(p, ySide, i + MIN_CHUNK)) out.push(i + MIN_CHUNK); return out; }
/// = next_bin: the next bin at or beyond `from` holding the token bought. `bins.chunks` (a Set, set by Veyl.bins) are the
/// arrays available; reaching one that is not throws MissingBinArray, like the program.
function nextBin(p, bins, from, xForY) {
  const ySide = xForY, down = xForY; const has = ySide ? hasY : hasX;
  const scan = (c, start) => { if (bins.chunks && !bins.chunks.has(c)) throw new Error('MissingBinArray');
    for (let s = start; down ? s >= 0 : s < BINS_PER_ARRAY; s += down ? -1 : 1) { const b = bins.get(c * BINS_PER_ARRAY + s); if (b && has(b)) return c * BINS_PER_ARRAY + s; } return null; };
  const c = chunkOf(from);
  if (chunkBit(p, ySide, c)) { const r = scan(c, slotOf(from)); if (r !== null) return r; }
  const c2 = nextChunk(p, ySide, c, down); if (c2 === null) return null;
  const r = scan(c2, down ? BINS_PER_ARRAY - 1 : 0); if (r === null) throw new Error('BitmapMismatch'); return r;
}
/// The protocol fee of a swap of `amount` (= veyl_bin `protocol_fee_of`): ceil(amount * bps / 10_000), off the input first.
const protocolFeeOf = (amount, bps = PROTOCOL_FEE_BPS) => (BigInt(amount) * BigInt(bps) + BPS - 1n) / BPS;
/// `_simulate` (exact twin of programs/veyl_bin `simulate`): `bins` = Map id -> bin (Veyl.bins). Throws like the program.
/// Returns { out, fee (LP + protocol), protocolFee (0.2% of the input + LP fee nobody could earn), lpFee, endId, volAcc, touched: [{ id, ...new bin state }] }.
function simulateSwap(p, bins, xForY, amountIn, now = Math.floor(Date.now() / 1000)) {
  if (!p.seeded) throw new Error('InsufficientLiquidity');
  const protoIn = protocolFeeOf(amountIn, p.protocolFeeBps === undefined ? PROTOCOL_FEE_BPS : p.protocolFeeBps);
  const { ref, iref } = refsOf(p, now); let left = BigInt(amountIn) - protoIn; let id = p.activeId; let out = 0n, fee = protoIn, protocolFee = protoIn, volAcc = 0n; const touched = [];
  for (let step = 0; left > 0n; step++) {
    const nid = nextBin(p, bins, id, xForY); if (nid === null) throw new Error('InsufficientLiquidity'); id = nid;
    if (step === MAX_STEPS) throw new Error('TooManySteps');
    volAcc = accOf(ref, iref, id); const f = feeOf(p, volAcc);
    const b = { ...EMPTY_BIN, ...(bins.get(id) || {}) }; b.rewardG = [...(b.rewardG || [0n, 0n])];
    const mmAvail = xForY ? b.y : b.x, loAvail = xForY ? b.bidY : b.askX; const avail = mmAvail + loAvail;
    if (avail === 0n) throw new Error('BitmapMismatch');
    const price = priceOf(p.basePrice, p.binStep, id);
    const inNoFee = xForY ? mulDivCeil(avail, Q, price) : mulDivCeil(avail, price, Q);
    const feeMax = mulDivCeil(inNoFee, f, PIPS - f); const maxIn = inNoFee + feeMax;
    let used, got, feeAmt;
    if (left >= maxIn) { used = maxIn; got = avail; feeAmt = feeMax; }
    else { used = left; feeAmt = mulDivCeil(left, f, PIPS); const net = left - feeAmt; got = xForY ? mulDiv(net, price, Q) : mulDiv(net, Q, price); if (got > avail) got = avail; }
    const lpFee = feeAmt; const net = used - feeAmt;
    const loGot = (got * loAvail) / avail; const mmGot = got - loGot;
    const loIn = got === 0n ? 0n : (net * loGot) / got, loFee = got === 0n ? 0n : (lpFee * loGot) / got; const mmIn = net - loIn, mmFee = lpFee - loFee;
    const eligible = b.shares > MIN_LIQUIDITY ? b.shares - MIN_LIQUIDITY : 0n; let protoExtra = 0n;
    if (mmFee > 0n) { if (eligible > 0n) { const add = (mmFee << 64n) / eligible; if (xForY) b.feeGx = (b.feeGx + add) % U128; else b.feeGy = (b.feeGy + add) % U128; } else protoExtra = mmFee; }
    if (xForY) { b.x += mmIn; b.y -= mmGot; b.bidY -= loGot; b.bidFilledX += loIn + loFee; } else { b.y += mmIn; b.x -= mmGot; b.askX -= loGot; b.askFilledY += loIn + loFee; }
    for (const v of [b.x, b.y, b.bidFilledX, b.askFilledY]) if (v > U64MAX) throw new Error('Overflow');
    touched.push({ id, ...b, mmFee, loFee, proto: protoExtra }); out += got; fee += feeAmt; protocolFee += protoExtra; left -= used;
    if (left > 0n) id = xForY ? id - 1 : id + 1;
  }
  return { out, fee, protocolFee, lpFee: fee - protoIn, endId: id, volAcc, touched };
}
/// What `shares` of a position slot earned since its checkpoints (fees per token, rewards), Q64.64 growth, wrapping.
const owedOf = (now, cp, shares) => ((((BigInt(now) - BigInt(cp)) % U128) + U128) % U128) * BigInt(shares) >> 64n;
/// Reward growth the active bin would get if rewards were updated at `now` (= BinPool::update_rewards), per reward index.
function pendingRewardGrowth(p, activeBin, now) { const out = [0n, 0n]; const eligible = activeBin && activeBin.shares > MIN_LIQUIDITY ? activeBin.shares - MIN_LIQUIDITY : 0n;
  (p.rewards || []).forEach((r, i) => { if (!r.initialized) return; const t = BigInt(Math.min(Number(now), Number(r.end))); if (t > r.lastUpdate && eligible > 0n) out[i] = (r.rate * (t - r.lastUpdate)) / eligible; }); return out; }
/// Weights against the active bin at execution (= veyl_bin `side_weights`): X weights below it and Y weights above it dropped.
function sideWeights(ids, weightsX, weightsY, active) { return { weightsX: ids.map((id, i) => (id >= active ? weightsX[i] : 0)), weightsY: ids.map((id, i) => (id <= active ? weightsY[i] : 0)) }; }
/// Split `total` by `weights`, the last weighted entry taking the remainder (= veyl_bin `distribute`).
function distribute(total, weights) { const T = BigInt(total); const w = weights.reduce((a, x) => a + BigInt(x), 0n); if (w === 0n) return weights.map(() => 0n);
  let last = -1; weights.forEach((x, i) => { if (Number(x) > 0) last = i; }); let sum = 0n;
  return weights.map((x, i) => { const a = i === last ? T - sum : (T * BigInt(x)) / w; sum += a; return a; }); }
/// Liquidity shapes as weights over `ids` around `active` (Meteora's linear base + delta*k): spot (flat), curve (heavier
/// near the active bin), bidAsk (heavier at the edges). X weights on bins >= active, Y weights on bins <= active.
function shapeWeights(ids, active, shape = 'spot') { const m = Math.max(1, ...ids.map((id) => Math.abs(id - active)));
  const w = (k) => { if (shape === 'curve') return Math.max(1, Math.round(10_000 * (m + 1 - k) / (m + 1))); if (shape === 'bidAsk') return Math.max(1, Math.round(10_000 * (k + 1) / (m + 1))); return 10_000; };
  return { weightsX: ids.map((id) => (id >= active ? w(Math.abs(id - active)) : 0)), weightsY: ids.map((id) => (id <= active ? w(Math.abs(id - active)) : 0)) }; }
/// Shares for a mint into one bin (same rounding as the program), given the bin's state and the current fee.
function sharesForMint(p, bin, id, active, x, y, fee) {
  const price = priceOf(p.basePrice, p.binStep, id); const xv = mulDiv(BigInt(x), price, Q); let liq = xv + BigInt(y);
  const bxv = mulDiv(BigInt(bin.x), price, Q); const lb = bxv + BigInt(bin.y); let supply = BigInt(bin.shares);
  if (supply === 0n || lb === 0n) { if (supply === 0n) { if (liq <= MIN_LIQUIDITY) return 0n; return liq - MIN_LIQUIDITY; } return liq; }
  if (id === active) { const ideal = mulDiv(liq, bxv, lb); const excess = xv > ideal ? xv - ideal : ideal - xv; liq -= mulDivCeil(excess, fee, PIPS); }
  return mulDiv(liq, supply, lb);
}
const chunkOf = (id) => Math.floor(id / BINS_PER_ARRAY);
const slotOf = (id) => ((id % BINS_PER_ARRAY) + BINS_PER_ARRAY) % BINS_PER_ARRAY;
/// Bin arrays a swap gets (always the same count, so a proof's route stays valid while the pool changes): the active bin's,
/// then the next arrays holding the token bought (from the pool's bitmap), padded with the following array addresses
/// (which may not exist: the program ignores those). `n` = how many; a swap needing more fails with MissingBinArray.
function chunksForSwap(p, xForY, n = SWAP_ARRAYS) {
  const down = xForY; const out = [chunkOf(p.activeId)]; let cur = out[0];
  while (out.length < n) { const nx = nextChunk(p, xForY, cur, down); if (nx === null) break; if (!out.includes(nx)) out.push(nx); cur = nx; }
  let pad = out[out.length - 1]; while (out.length < n) { pad += down ? -1 : 1; if (!out.includes(pad)) out.push(pad); }
  return out;
}

// ------------------------------------------------------------------------------------------------ account layouts (programs/veyl_bin)
function decodeBinPool(address, data) { const r = new Reader(data.subarray(8));
  const p = { address, factory: r.pk(), mintX: r.pk(), mintY: r.pk(), vaultX: r.pk(), vaultY: r.pk(), tokenProgramX: r.pk(), tokenProgramY: r.pk(), basePrice: r.be32(), stepQ: r.be32(), variableFeeControl: r.u64(), volAcc: r.u64(), volRef: r.u64(), lastSwapAt: r.i64(), activeId: r.i32(), lowestId: r.i32(), highestId: r.i32(), idRef: r.i32(), baseFee: r.u32(), binStep: r.u16(), seeded: r.u8() === 1, bump: r.u8() };
  p.protocolFeeBps = r.u16(); p.delisted = r.u8() === 1; p.feeTier = r.u8(); r.skip(4); p.protocolShare = 0; p.protocolFeeX = r.u64(); p.protocolFeeY = r.u64(); p.totalFeeX = r.u64(); p.totalFeeY = r.u64();
  p.bitmapX = []; for (let i = 0; i < BITMAP_WORDS; i++) p.bitmapX.push(r.u64()); p.bitmapY = []; for (let i = 0; i < BITMAP_WORDS; i++) p.bitmapY.push(r.u64());
  p.rewards = []; for (let i = 0; i < NUM_REWARDS; i++) { const x = { mint: r.pk(), vault: r.pk(), funder: r.pk(), tokenProgram: r.pk(), rate: r.u128(), duration: r.u64(), end: r.i64(), lastUpdate: r.i64(), ineligible: r.u64() }; x.initialized = !x.mint.equals(PublicKey.default); p.rewards.push(x); }
  return p; }
/// The factory (Factory in programs/veyl_bin): roles, treasury, listing bond, protocol fee and fee tiers.
function decodeFactory(data) { const r = new Reader(data.subarray(8));
  const f = { authority: r.pk(), pendingAuthority: r.pk(), bump: r.u8(), feeAuthority: r.pk(), pendingFeeAuthority: r.pk(), treasury: r.pk(), bondLamports: r.u64(), bondLock: r.i64(), protocolFeeBps: r.u16() };
  const n = r.u8(); f.tiers = []; for (let i = 0; i < MAX_TIERS; i++) { const t = { index: i, binStep: r.u16(), baseFee: r.u32(), vfc: r.u64(), enabled: r.u8() === 1 }; if (i < n) f.tiers.push(t); } return f; }
function decodeBond(data) { const r = new Reader(data.subarray(8)); return { pool: r.pk(), creator: r.pk(), amount: r.u64(), createdAt: r.i64(), unlockAt: r.i64(), bump: r.u8() }; }
/// The canonical order of a pair (veyl_bin requires mint_x < mint_y by bytes): [x, y, flipped].
function canonicalPair(a, b) { a = new PublicKey(a); b = new PublicKey(b); const c = Buffer.compare(a.toBuffer(), b.toBuffer()); if (c === 0) throw new Error('same mint'); return c < 0 ? [a, b, false] : [b, a, true]; }
/// Token-2022 mint extensions (ExtensionType numbers) and the ones veyl_bin's `check_mint` accepts: metadata / group
/// pointers and data, which cannot alter a transfer or a balance. Every other extension (and any unknown one) is refused.
const MINT_EXT = { 1: 'TransferFeeConfig', 3: 'MintCloseAuthority', 4: 'ConfidentialTransferMint', 6: 'DefaultAccountState', 9: 'NonTransferable', 10: 'InterestBearingConfig', 12: 'PermanentDelegate', 14: 'TransferHook',
  16: 'ConfidentialTransferFeeConfig', 18: 'MetadataPointer', 19: 'TokenMetadata', 20: 'GroupPointer', 21: 'TokenGroup', 22: 'GroupMemberPointer', 23: 'TokenGroupMember', 24: 'ConfidentialMintBurn', 25: 'ScaledUiAmount', 26: 'Pausable', 28: 'PermissionedBurn' };
const MINT_EXT_OK = new Set([18, 19, 20, 21, 22, 23]);
/// A mint account ({ owner, data }) -> { program: 'spl' | 'token2022', decimals, initialized, supply, mintAuthority,
/// freezeAuthority, extensions: [ExtensionType], metadata: { name, symbol, uri } | null (Token-2022 TokenMetadata) }; null
/// when the account is not a mint of either token program.
function parseMint(info) {
  if (!info) return null; const owner = new PublicKey(info.owner); const d = Buffer.from(info.data);
  const program = owner.equals(TOKEN_PROGRAM) ? 'spl' : owner.equals(TOKEN_2022) ? 'token2022' : null; if (!program || d.length < 82 || (program === 'spl' && d.length !== 82)) return null;
  const opt32 = (o) => (d.readUInt32LE(o) === 1 ? new PublicKey(d.subarray(o + 4, o + 36)) : null);
  const m = { program, mintAuthority: opt32(0), supply: d.readBigUInt64LE(36), decimals: d[44], initialized: d[45] === 1, freezeAuthority: opt32(46), extensions: [], metadata: null };
  if (d.length > 82) { if (d.length < 166 || d[165] !== 1) return null; /* account type 1 = Mint, after the base padded to 165 bytes */
    for (let o = 166; o + 4 <= d.length;) { const type = d.readUInt16LE(o), len = d.readUInt16LE(o + 2); if (type === 0) break; m.extensions.push(type);
      if (type === 19) { try { const r = new Reader(d.subarray(o + 4, o + 4 + len)); r.skip(64); m.metadata = { name: r.str(), symbol: r.str(), uri: r.str() }; } catch { /* malformed: no metadata */ } }
      o += 4 + len; } }
  return m; }
/// The extensions of a parsed mint that veyl_bin refuses ([] = the mint can be listed), as { type, name }.
const refusedExtensions = (m) => (m && m.program === 'token2022' ? m.extensions.filter((t) => !MINT_EXT_OK.has(t)).map((t) => ({ type: t, name: MINT_EXT[t] || 'Extension' + t })) : []);
/// 128.128 price of raw Y per raw X from a human price (Y per X) and the two decimals (= scripts/lib.js priceQ).
const priceQ = (human, decX, decY) => { const scaled = Number(human) * 10 ** (decY - decX); const [i, f = ''] = scaled.toExponential(15).split('e'); const m = BigInt(Math.round(Number(i) * 1e15)); const e = Number(f) - 15; return e >= 0 ? m * 10n ** BigInt(e) * Q : (m * Q) / 10n ** BigInt(-e); };
/// A tier's category by bin step (DEFAULT_FEE_TIERS' grouping): stable <= 5, major <= 30, volatile above.
const tierCategory = (binStep) => (binStep <= 5 ? 'stable' : binStep <= 30 ? 'major' : 'volatile');
/// A tier's label: DEFAULT_FEE_TIERS' when the bin step and fee match one, else category + fee ("Volatile 0.75%").
function tierLabel(binStep, baseFee) { const d = DEFAULT_FEE_TIERS.find((t) => t.binStep === Number(binStep) && t.baseFee === Number(baseFee)); if (d) return d.label;
  const c = tierCategory(Number(binStep)); return c[0].toUpperCase() + c.slice(1) + ' ' + +(Number(baseFee) / 1e4).toPrecision(3) + '%'; }
const BIN_POOL_DISC = disc('BinPool', 'account');
function decodeBin(r, id) { return { id, x: r.u64(), y: r.u64(), shares: r.u128(), feeGx: r.u128(), feeGy: r.u128(), rewardG: [r.u128(), r.u128()], askShares: r.u128(), askX: r.u64(), askFilledY: r.u64(), bidShares: r.u128(), bidY: r.u64(), bidFilledX: r.u64() }; }
function decodeBinArray(data) { const r = new Reader(data.subarray(8)); const pool = r.pk(); const chunk = r.i32(); r.skip(4); const bitmapX = r.u64(), bitmapY = r.u64(); const bins = [];
  for (let i = 0; i < BINS_PER_ARRAY; i++) bins.push(decodeBin(r, chunk * BINS_PER_ARRAY + i)); return { pool, chunk, bitmapX, bitmapY, bins }; }
function decodeShareAccount(data) { const r = new Reader(data.subarray(8)); const a = { pool: r.pk(), owner: r.pk(), authority: r.pk(), chunk: r.i32() }; r.skip(4);
  a.pendingFeeX = r.u64(); a.pendingFeeY = r.u64(); a.pendingReward = [r.u64(), r.u64()]; a.slots = [];
  for (let i = 0; i < BINS_PER_ARRAY; i++) a.slots.push({ shares: r.u128(), feeCpX: r.u128(), feeCpY: r.u128(), rewardCp: [r.u128(), r.u128()], askShares: r.u128(), bidShares: r.u128() }); return a; }

/// A lookup table as a transaction can use it now: addresses added in the current slot resolve only from the next one
/// (a transaction naming them fails), so they are left out until then; a deactivated table (closing) is null.
async function usableLut(conn, t) { if (!t || !t.isActive()) return null; const s = t.state; if (s.lastExtendedSlotStartIndex >= s.addresses.length) return t;
  if ((await conn.getSlot('confirmed')) > Number(s.lastExtendedSlot)) return t;
  return new AddressLookupTableAccount({ key: t.key, state: { ...s, addresses: s.addresses.slice(0, s.lastExtendedSlotStartIndex) } }); }

// ------------------------------------------------------------------------------------------------ the client
class Veyl {
  /// programs: { pool, bin, entry } program ids. payer: Keypair used to sign and pay by default.
  constructor({ rpc, connection, programs, payer }) {
    this.conn = connection || new Connection(rpc, 'confirmed');
    this.programs = { pool: new PublicKey(programs.pool), bin: new PublicKey(programs.bin), entry: new PublicKey(programs.entry) };
    this.payer = payer; this._tp = {}; this.lookupTable = null; this.lookupExtra = []; this._luts = {}; // lookupExtra: more tables when one (256 addresses) is not enough
  }
  // ---- addresses
  pda(seeds, program) { return PublicKey.findProgramAddressSync(seeds, program)[0]; }
  poolPda(mint) { return this.pda([Buffer.from('pool'), pk(mint)], this.programs.pool); }
  depositPda(pool, label) { return this.pda([Buffer.from('dep'), pk(pool), be32(label)], this.programs.pool); }
  spendPda(pool, nullifierHash) { return this.pda([Buffer.from('null'), pk(pool), be32(nullifierHash)], this.programs.pool); }
  factoryPda() { return this.pda([Buffer.from('factory')], this.programs.bin); }
  binPoolPda(mintX, mintY, binStep) { return this.pda([Buffer.from('bin'), pk(mintX), pk(mintY), u16(binStep)], this.programs.bin); }
  bondPda(pool) { return this.pda([Buffer.from('bond'), pk(pool)], this.programs.bin); }
  rewardVaultPda(pool, index) { return this.pda([Buffer.from('reward_vault'), pk(pool), u8(index)], this.programs.bin); }
  binArrayPda(pool, chunk) { return this.pda([Buffer.from('bins'), pk(pool), i32(chunk)], this.programs.bin); }
  sharesPda(pool, owner, authority, chunk) { return this.pda([Buffer.from('shares'), pk(pool), pk(owner), pk(authority), i32(chunk)], this.programs.bin); }
  entryPda() { return this.pda([Buffer.from('entry')], this.programs.entry); }
  signerPda() { return this.pda([Buffer.from('signer')], this.programs.entry); }
  noncePda(owner) { return this.pda([Buffer.from('nonce'), pk(owner)], this.programs.entry); }
  /// The upgradeable loader's ProgramData account of a program (holds its upgrade authority).
  programDataPda(program) { return this.pda([pk(program)], BPF_UPGRADEABLE_LOADER); }
  ata(mint, owner, tokenProgram = TOKEN_PROGRAM) { return PublicKey.findProgramAddressSync([pk(owner), pk(tokenProgram), pk(mint)], ATA_PROGRAM)[0]; }
  async tokenProgram(mint) { const k = new PublicKey(mint).toBase58(); if (!this._tp[k]) { const a = await this.conn.getAccountInfo(new PublicKey(mint)); if (!a) throw new Error('mint not found: ' + k); this._tp[k] = a.owner; } return this._tp[k]; }
  async entryVault(mint) { return this.ata(mint, this.signerPda(), await this.tokenProgram(mint)); }

  // ---- transactions
  async tx(ixs, feePayer, cu = 400_000) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs);
    tx.feePayer = feePayer; tx.recentBlockhash = (await this.conn.getLatestBlockhash()).blockhash; return tx;
  }
  async send(ixs, signers = [], cu = 400_000) {
    const fee = this.payer || signers[0]; const tx = await this.tx(ixs, fee.publicKey, cu);
    const all = [fee, ...signers.filter((s) => !s.publicKey.equals(fee.publicKey))]; tx.sign(...all);
    return this._confirm(await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false }));
  }
  /// v0 transaction with an address lookup table (big instructions like private_swap / private_add need one).
  async sendV0(ixs, signers = [], cu = 1_400_000, lookupTable = this.lookupTable) { return this.sendSigned(await this.buildV0(ixs, signers, cu, lookupTable)); }
  /// The signed v0 transaction sendV0 sends (to simulate it first: see sendV0Checked in shield.js).
  async buildV0(ixs, signers = [], cu = 1_400_000, lookupTable = this.lookupTable) {
    const fee = this.payer || signers[0]; const tables = [];
    for (const k of [lookupTable, ...(lookupTable === this.lookupTable ? this.lookupExtra || [] : [])].filter(Boolean)) { const t = await this.lutAccount(k); if (t) tables.push(t); }
    const msg = new TransactionMessage({ payerKey: fee.publicKey, recentBlockhash: (await this.conn.getLatestBlockhash()).blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs] }).compileToV0Message(tables);
    const tx = new VersionedTransaction(msg); tx.sign([fee, ...signers.filter((s) => !s.publicKey.equals(fee.publicKey))]); return tx;
  }
  async sendSigned(tx) { return this._confirm(await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false })); }
  async _confirm(sig) { const r = await this.conn.confirmTransaction(sig, 'confirmed'); if (r.value.err) throw new Error('tx failed: ' + JSON.stringify(r.value.err)); return sig; }
  /// A transaction's events, only those our programs logged (a relayer-built transaction could add a program logging look-alikes).
  async events(sig) { const t = await this.conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); const ours = new Set(Object.values(this.programs).map((p) => new PublicKey(p).toBase58()));
    return logEvents(t && t.meta && t.meta.logMessages).filter((e) => ours.has(e.program)).map(({ program, ...e }) => e); }
  async returnData(sig) { const t = await this.conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); const r = t && t.meta && t.meta.returnData; return r ? Buffer.from(r.data[0], 'base64') : null; }
  /// A lookup table account, cached for 30 s (this client's own extends clear it), as a transaction may use it now
  /// (usableLut: addresses added in the current slot only resolve from the next one); null when missing or deactivated.
  async lutAccount(k) { const key = new PublicKey(k).toBase58(); const c = this._luts[key]; if (c && Date.now() - c.at < 30_000) return c.v;
    const raw = (await this.conn.getAddressLookupTable(new PublicKey(key))).value; const t = await usableLut(this.conn, raw); if (t === raw) this._luts[key] = { v: t, at: Date.now() }; return t; }
  /// Every address into lookup tables of at most 256: `tables` = existing ones (extended where there is room), new ones made as needed.
  async fillLookupTables(authority, addresses, tables = []) { const out = []; const have = new Set();
    for (const t of tables) { const cur = (await this.conn.getAddressLookupTable(new PublicKey(t))).value; if (!cur || !cur.state.authority || !cur.state.authority.equals(authority.publicKey)) continue; out.push({ key: new PublicKey(t), n: cur.state.addresses.length }); for (const a of cur.state.addresses) have.add(a.toBase58()); }
    let add = [...new Map(addresses.map((a) => [new PublicKey(a).toBase58(), new PublicKey(a)])).values()].filter((a) => !have.has(a.toBase58()));
    for (const o of out) { const room = 256 - o.n; if (room <= 0 || !add.length) continue; const part = add.slice(0, room); add = add.slice(room); await this.extendLookupTable(authority, part, o.key); o.n += part.length; }
    while (add.length) { const part = add.slice(0, 256); add = add.slice(256); const t = await this.createLookupTable(authority, part); out.push({ key: t, n: part.length }); }
    this._luts = {}; return out.map((o) => o.key); }
  /// Create an address lookup table holding `addresses` (the relayer does this once for every static account).
  async createLookupTable(authority, addresses) {
    const slot = await this.conn.getSlot('finalized');
    const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: authority.publicKey, recentSlot: slot });
    await this.send([createIx], [authority], 50_000);
    const uniq = [...new Map(addresses.map((a) => [new PublicKey(a).toBase58(), new PublicKey(a)])).values()];
    for (let i = 0; i < uniq.length; i += 20) await this.send([AddressLookupTableProgram.extendLookupTable({ payer: authority.publicKey, authority: authority.publicKey, lookupTable: table, addresses: uniq.slice(i, i + 20) })], [authority], 50_000);
    if (!this.lookupTable) this.lookupTable = table; this._luts = {}; return table; /* a client with a table keeps it as its first (deployAll sets it) */
  }
  async extendLookupTable(authority, addresses, table = this.lookupTable) {
    const cur = (await this.conn.getAddressLookupTable(new PublicKey(table))).value; const have = new Set(cur.state.addresses.map((a) => a.toBase58()));
    const add = [...new Map(addresses.map((a) => [new PublicKey(a).toBase58(), new PublicKey(a)])).values()].filter((a) => !have.has(a.toBase58()));
    for (let i = 0; i < add.length; i += 20) await this.send([AddressLookupTableProgram.extendLookupTable({ payer: authority.publicKey, authority: authority.publicKey, lookupTable: new PublicKey(table), addresses: add.slice(i, i + 20) })], [authority], 50_000);
    this._luts = {}; return add.length;
  }
  async tokenBalance(mint, owner) { try { const tp = await this.tokenProgram(mint); const b = await this.conn.getTokenAccountBalance(this.ata(mint, owner, tp)); return BigInt(b.value.amount); } catch { return 0n; } }

  // ---- decoders
  async pool(pool) { const a = await this.conn.getAccountInfo(new PublicKey(pool)); if (!a) return null; const r = new Reader(a.data.subarray(8));
    const p = { address: new PublicKey(pool), authority: r.pk(), pendingAuthority: r.pk(), postman: r.pk(), mint: r.pk(), vault: r.pk(), tokenProgram: r.pk(), minDeposit: r.u64(), depositNonce: r.u64(), nextIndex: r.u64(), currentRootIndex: r.u64(), aspIndex: r.u64(), bump: r.u8() };
    r.skip(7); p.aspRoot = r.be32(); p.aspRoots = []; for (let i = 0; i < ASP_HISTORY; i++) p.aspRoots.push(r.be32()); r.skip(32 * STATE_DEPTH * 2); p.roots = []; for (let i = 0; i < ROOT_HISTORY; i++) p.roots.push(r.be32()); p.rootSlot = r.u64();
    p.currentRoot = p.roots[Number(p.currentRootIndex)]; p.isKnownRoot = (x) => BigInt(x) !== 0n && p.roots.includes(BigInt(x)); p.isKnownAspRoot = (x) => BigInt(x) !== 0n && p.aspRoots.includes(BigInt(x)); return p; }
  async depositRecord(addr) { const a = await this.conn.getAccountInfo(new PublicKey(addr)); if (!a) return null; const r = new Reader(a.data.subarray(8)); return { pool: r.pk(), beneficiary: r.pk(), label: r.be32(), commitment: r.be32(), value: r.u64(), bump: r.u8() }; }
  async spend(addr) { const a = await this.conn.getAccountInfo(new PublicKey(addr)); if (!a) return null; const r = new Reader(a.data.subarray(8));
    return { pool: r.pk(), poster: r.pk(), processor: r.pk(), status: r.u8(), nullifierHash: r.be32(), newCommitment: r.be32(), value: r.u64(), aspRoot: r.be32(), context: r.be32(), expiresAt: r.u64(), bump: r.u8() }; }
  async isSpent(pool, nullifierHash) { const s = await this.spend(this.spendPda(pool, nullifierHash)); return !!s && s.status === 2; }
  async factory() { const a = await this.conn.getAccountInfo(this.factoryPda()); if (!a) return null; return decodeFactory(a.data); }
  /// A pool's listing bond (null once released or forfeited).
  async bond(pool) { const a = await this.conn.getAccountInfo(this.bondPda(pool)); if (!a || !a.owner.equals(this.programs.bin)) return null; return decodeBond(a.data); }
  /// Index of the factory tier with this bin step (and fees, when given), or -1.
  /// Every bin pool of the program, decoded (getProgramAccounts: BinPool's discriminator and size). `keysOnly`: only the
  /// addresses (a cheap count for "is there a new pool").
  async binPools({ keysOnly = false } = {}) { const filters = [{ dataSize: SIZES.binPool }, { memcmp: { offset: 0, bytes: BIN_POOL_DISC.toString('base64'), encoding: 'base64' } }];
    const rows = await this.conn.getProgramAccounts(this.programs.bin, { commitment: 'confirmed', filters, ...(keysOnly ? { dataSlice: { offset: 0, length: 0 } } : {}) });
    return keysOnly ? rows.map((r) => r.pubkey) : rows.map((r) => decodeBinPool(r.pubkey, r.account.data)); }
  /// Listing bonds of many pools in one read each 100 (null where released, forfeited or never made).
  async bonds(pools) { const out = []; for (let i = 0; i < pools.length; i += 100) { const part = pools.slice(i, i + 100); const infos = await this.conn.getMultipleAccountsInfo(part.map((p) => this.bondPda(p)), 'confirmed');
    infos.forEach((a) => out.push(a && a.owner.equals(this.programs.bin) && a.data.length >= SIZES.bond ? decodeBond(a.data) : null)); } return out; }
  /// A mint, parsed (parseMint), or null.
  async mint(mint) { return parseMint(await this.conn.getAccountInfo(new PublicKey(mint), 'confirmed')); }
  async tierIndex(binStep, baseFee, vfc) { const f = await this.factory(); if (!f) return -1; const t = f.tiers.find((t) => t.binStep === Number(binStep) && (baseFee === undefined || t.baseFee === Number(baseFee)) && (vfc === undefined || t.vfc === BigInt(vfc))); return t ? t.index : -1; }
  /// A bin pool, decoded (BinPool in programs/veyl_bin), with its bitmaps (BigInt words) and reward slots.
  async binPool(pool) { const a = await this.conn.getAccountInfo(new PublicKey(pool)); if (!a) return null; return decodeBinPool(new PublicKey(pool), a.data); }
  /// The 60 bins of one array (null when the array does not exist), each with reserves, shares, fee / reward growth and limit orders.
  async binArray(pool, chunk) { const a = await this.conn.getAccountInfo(this.binArrayPda(pool, chunk)); if (!a) return null; return decodeBinArray(a.data).bins; }
  /// Map id -> bin for the given chunks (missing arrays = empty bins); `map.chunks` = the chunks read (for the JS twin).
  async bins(pool, chunks) { const m = new Map(); m.chunks = new Set(chunks); const keys = chunks.map((c) => this.binArrayPda(pool, c));
    const infos = keys.length ? await this.conn.getMultipleAccountsInfo(keys) : [];
    infos.forEach((a) => { if (a) for (const b of decodeBinArray(a.data).bins) m.set(b.id, b); }); return m; }
  /// A share account, fully decoded: pending (settled, unclaimed) fees and rewards, and per slot the shares, checkpoints and order shares.
  async shareAccount(pool, owner, authority, chunk) { const a = await this.conn.getAccountInfo(this.sharesPda(pool, owner, authority, chunk)); if (!a) return null; return decodeShareAccount(a.data); }
  /// Shares per slot of one share account (array of 60, or null).
  async shares(pool, owner, authority, chunk) { const s = await this.shareAccount(pool, owner, authority, chunk); return s ? s.slots.map((x) => x.shares) : null; }
  async sharesOf(pool, owner, authority, id) { const s = await this.shares(pool, owner, authority, chunkOf(id)); return s ? s[slotOf(id)] : 0n; }
  /// Everything a position (owner, authority) holds in `ids` right now, for display: per bin its shares, reserve value,
  /// unclaimed fees and rewards (including emission not yet written on chain) and limit orders; and the totals, which add
  /// the pending balances already settled into the share accounts. Read-only; nothing here leaves the device.
  async position(pool, owner, authority, ids, now = Math.floor(Date.now() / 1000)) {
    pool = new PublicKey(pool); const p = await this.binPool(pool); const chunks = [...new Set([...ids.map(chunkOf), chunkOf(p.activeId)])];
    const bins = await this.bins(pool, chunks); const accts = {}; for (const c of [...new Set(ids.map(chunkOf))]) accts[c] = await this.shareAccount(pool, owner, authority, c);
    const extra = pendingRewardGrowth(p, bins.get(p.activeId), now);
    const out = { bins: [], value: { x: 0n, y: 0n }, fees: { x: 0n, y: 0n }, rewards: [0n, 0n], orders: [] };
    for (const a of Object.values(accts)) if (a) { out.fees.x += a.pendingFeeX; out.fees.y += a.pendingFeeY; a.pendingReward.forEach((v, i) => { out.rewards[i] += v; }); }
    for (const id of [...new Set(ids)]) { const a = accts[chunkOf(id)]; if (!a) continue; const sl = a.slots[slotOf(id)]; const b = bins.get(id) || { ...EMPTY_BIN, id };
      const v = this.valueOf(b, sl.shares); const fx = owedOf(b.feeGx, sl.feeCpX, sl.shares), fy = owedOf(b.feeGy, sl.feeCpY, sl.shares);
      const rw = [0, 1].map((i) => owedOf((b.rewardG[i] + (id === p.activeId ? extra[i] : 0n)) % U128, sl.rewardCp[i], sl.shares));
      const ask = sl.askShares > 0n ? { shares: sl.askShares, unfilledX: mulDiv(b.askX, sl.askShares, b.askShares), filledY: mulDiv(b.askFilledY, sl.askShares, b.askShares) } : null;
      const bid = sl.bidShares > 0n ? { shares: sl.bidShares, unfilledY: mulDiv(b.bidY, sl.bidShares, b.bidShares), filledX: mulDiv(b.bidFilledX, sl.bidShares, b.bidShares) } : null;
      if (sl.shares === 0n && !ask && !bid) continue;
      out.bins.push({ id, shares: sl.shares, value: v, fees: { x: fx, y: fy }, rewards: rw, ask, bid });
      out.value.x += v.x; out.value.y += v.y; out.fees.x += fx; out.fees.y += fy; out.rewards[0] += rw[0]; out.rewards[1] += rw[1];
      if (ask) out.orders.push({ id, isAsk: true, ...ask, filled: ask.unfilledX === 0n }); if (bid) out.orders.push({ id, isAsk: false, ...bid, filled: bid.unfilledY === 0n }); }
    return out; }
  async entry() { const a = await this.conn.getAccountInfo(this.entryPda()); if (!a) return null; const r = new Reader(a.data.subarray(8)); return { bump: r.u8(), signerBump: r.u8() }; }
  async nonce(owner) { const a = await this.conn.getAccountInfo(this.noncePda(owner)); if (!a) return 0n; const r = new Reader(a.data.subarray(8)); r.pk(); return r.u64(); }
  /// What `shares` in bin `id` are worth right now (EVM valueOf).
  valueOf(bin, shares) { if (!bin || bin.shares === 0n) return { x: 0n, y: 0n }; return { x: mulDiv(bin.x, BigInt(shares), bin.shares), y: mulDiv(bin.y, BigInt(shares), bin.shares) }; }
  /// Withdrawable protocol fees of a pool (accounted in its vaults).
  async protocolFees(pool) { const p = await this.binPool(pool); return { x: p.protocolFeeX, y: p.protocolFeeY, bps: p.protocolFeeBps }; }

  // ---- veyl_pool instructions
  async initPoolIx(authority, mint, minDeposit, postman) { const tp = await this.tokenProgram(mint); const pool = this.poolPda(mint);
    return new TransactionInstruction({ programId: this.programs.pool, data: Buffer.concat([disc('init_pool'), u64(minDeposit), pk(postman)]), keys: [W(authority, true), R(this.programs.pool), R(this.programDataPda(this.programs.pool)), R(mint), W(pool), W(this.ata(mint, pool, tp)), R(tp), R(ATA_PROGRAM), R(SYS)] }); }
  poolAdminIx(name, authority, pool, data = Buffer.alloc(0)) { return new TransactionInstruction({ programId: this.programs.pool, data: Buffer.concat([disc(name), data]), keys: [R(authority, true), W(pool)] }); }
  setPostmanIx(authority, pool, postman) { return this.poolAdminIx('set_postman', authority, pool, pk(postman)); }
  proposeAuthorityIx(authority, pool, next) { return this.poolAdminIx('propose_authority', authority, pool, pk(next)); }
  acceptAuthorityIx(next, pool) { return this.poolAdminIx('accept_authority', next, pool); }
  updateAspRootIx(postman, pool, root, cid = '') { return this.poolAdminIx('update_asp_root', postman, pool, Buffer.concat([be32(root), str(cid)])); }
  resetAspRootsIx(postman, pool, root, cid = '') { return this.poolAdminIx('reset_asp_roots', postman, pool, Buffer.concat([be32(root), str(cid)])); }
  /// deposit(amount, precommitment, beneficiary). `payer` owns the tokens; `rentPayer` pays the record's rent (defaults to payer).
  async depositIx(payer, mint, amount, precommitment, beneficiary = payer, rentPayer = payer, nonce) {
    const pool = this.poolPda(mint); const p = await this.pool(pool); if (!p) throw new Error('pool not found for mint ' + new PublicKey(mint).toBase58());
    const label = labelOf(pool, nonce !== undefined ? nonce : p.depositNonce + 1n);
    return new TransactionInstruction({ programId: this.programs.pool, data: Buffer.concat([disc('deposit'), u64(amount), be32(precommitment), pk(beneficiary)]), keys: [
      R(payer, true), W(rentPayer, true), W(pool), R(p.mint), W(p.vault), W(this.ata(mint, payer, p.tokenProgram)), W(this.depositPda(pool, label)), R(p.tokenProgram), R(SYS)] }); }
  /// post_withdrawal(proof, pubs, processor, ttl): verifies the Groth16 proof on-chain. `prevPoster`: when this replaces a
  /// posted-but-unexecuted spend of the same note, that spend's poster (refunded its rent); see prevPosterOf.
  postWithdrawalIx(poster, pool, proofBytes, pubs, processor, ttlSlots = DEFAULT_TTL_SLOTS, prevPoster = poster) {
    if (proofBytes.length !== 256) throw new Error('proof must be 256 bytes');
    return new TransactionInstruction({ programId: this.programs.pool, data: Buffer.concat([disc('post_withdrawal'), proofBytes, ...pubs.map(be32), pk(processor), u64(ttlSlots)]), keys: [W(poster, true), R(pool), W(this.spendPda(pool, pubs[1])), W(prevPoster), R(SYS)] }); }
  /// What a new post of this nullifier needs: { spent } when it is spent already, else { prevPoster } (null: nothing posted).
  async prevPosterOf(pool, nullifierHash) { const s = await this.spend(this.spendPda(pool, nullifierHash)); if (!s) return { prevPoster: null }; if (s.status === 2) return { spent: true }; return { prevPoster: s.poster }; }
  /// withdraw(data): only meaningful for a processor that can sign; the entry program calls it by CPI. Exposed for tests.
  async withdrawIx(processor, pool, nullifierHash, processorToken, data) { const p = await this.pool(pool);
    return new TransactionInstruction({ programId: this.programs.pool, data: Buffer.concat([disc('withdraw'), vec([...data], u8)]), keys: [R(processor, true), W(pool), R(p.mint), W(p.vault), W(this.spendPda(pool, nullifierHash)), W(processorToken), R(p.tokenProgram)] }); }
  async cancelPostIx(canceller, pool, nullifierHash) { const s = await this.spend(this.spendPda(pool, nullifierHash)); if (!s) throw new Error('nothing posted');
    return new TransactionInstruction({ programId: this.programs.pool, data: disc('cancel_post'), keys: [R(canceller, true), W(s.poster), W(this.spendPda(pool, nullifierHash))] }); }
  async ragequitIx(beneficiary, mint, note) { const pool = this.poolPda(mint); const p = await this.pool(pool); const nh = H(note.nullifier);
    return new TransactionInstruction({ programId: this.programs.pool, data: Buffer.concat([disc('ragequit'), u64(note.value), be32(note.label), be32(note.nullifier), be32(note.secret)]), keys: [
      W(beneficiary, true), W(pool), R(p.mint), W(p.vault), W(this.depositPda(pool, note.label)), W(this.spendPda(pool, nh)), W(this.ata(mint, beneficiary, p.tokenProgram)), R(p.tokenProgram), R(SYS)] }); }

  // ---- veyl_bin instructions
  initFactoryIx(authority) { return new TransactionInstruction({ programId: this.programs.bin, data: disc('init_factory'), keys: [W(authority, true), R(this.programs.bin), R(this.programDataPda(this.programs.bin)), W(this.factoryPda()), R(SYS)] }); }
  proposeFactoryAuthorityIx(authority, next) { return new TransactionInstruction({ programId: this.programs.bin, data: Buffer.concat([disc('propose_factory_authority'), pk(next)]), keys: [R(authority, true), W(this.factoryPda())] }); }
  acceptFactoryAuthorityIx(next) { return new TransactionInstruction({ programId: this.programs.bin, data: disc('accept_factory_authority'), keys: [R(next, true), W(this.factoryPda())] }); }
  /// create_pool(tier index, basePrice 128.128, activeId), signed by anyone (`creator` pays the factory's bond, the factory
  /// authority none). mintX < mintY (canonicalPair); the tier's bin step is read from the factory (or pass `binStep`).
  async createPoolIx(creator, mintX, mintY, tier, basePrice, activeId = 0, binStep) {
    if (binStep === undefined) { const f = await this.factory(); const t = f && f.tiers[tier]; if (!t) throw new Error('no fee tier ' + tier); binStep = t.binStep; }
    const tpx = await this.tokenProgram(mintX), tpy = await this.tokenProgram(mintY); const pool = this.binPoolPda(mintX, mintY, binStep);
    return new TransactionInstruction({ programId: this.programs.bin, data: Buffer.concat([disc('create_pool'), u8(tier), be32(basePrice), i32(activeId)]), keys: [
      W(creator, true), R(this.factoryPda()), R(mintX), R(mintY), W(pool), W(this.bondPda(pool)), W(this.ata(mintX, pool, tpx)), W(this.ata(mintY, pool, tpy)), R(tpx), R(tpy), R(ATA_PROGRAM), R(SYS)] }); }
  addFeeTierIx(authority, binStep, baseFee, vfc) { return this.binIx('add_fee_tier', [u16(binStep), u32(baseFee), u64(vfc)], [R(authority, true), W(this.factoryPda())]); }
  setFeeTierEnabledIx(authority, index, enabled) { return this.binIx('set_fee_tier_enabled', [u8(index), u8(enabled ? 1 : 0)], [R(authority, true), W(this.factoryPda())]); }
  setBondIx(authority, lamports, lockSeconds) { return this.binIx('set_bond', [u64(lamports), i64(lockSeconds)], [R(authority, true), W(this.factoryPda())]); }
  setTreasuryIx(feeAuthority, treasury) { return this.binIx('set_treasury', [pk(treasury)], [R(feeAuthority, true), W(this.factoryPda())]); }
  releaseBondIx(creator, pool) { return this.binIx('release_bond', [], [W(creator, true), R(pool), W(this.bondPda(pool))]); }
  async delistPoolIx(authority, pool) { const f = await this.factory(); return this.binIx('delist_pool', [], [R(authority, true), R(this.factoryPda()), W(pool), W(this.bondPda(pool)), W(f.treasury)]); }
  /// devnet-only one-off migration (veyl_bin built with --features devnet-migrate; scripts/migrate-devnet.js): grow the old
  /// 137-byte factory to the current layout (the authority pays the extra rent), then bring each old pool to its tier.
  migrateFactoryIx(authority) { return this.binIx('migrate_factory', [], [W(authority, true), W(this.factoryPda()), R(SYS)]); }
  migratePoolIx(authority, pool) { return this.binIx('migrate_pool', [], [R(authority, true), R(this.factoryPda()), W(pool)]); }
  /// Pay protocol fees into a pool (anyone; veyl_entry for the matched part of a sealed batch).
  async payProtocolFeeIx(from, pool, amountX, amountY, { fromX, fromY } = {}) { const p = await this.binPool(pool); return this.binIx('pay_protocol_fee', [u64(amountX), u64(amountY)], this.mintKeys(from, pool, p, fromX, fromY)); }
  initBinArrayIx(payer, pool, chunk) { return new TransactionInstruction({ programId: this.programs.bin, data: Buffer.concat([disc('init_bin_array'), i32(chunk)]), keys: [W(payer, true), R(pool), W(this.binArrayPda(pool, chunk)), R(SYS)] }); }
  initSharesIx(payer, pool, owner, authority, chunk) { return new TransactionInstruction({ programId: this.programs.bin, data: Buffer.concat([disc('init_shares'), pk(owner), pk(authority), i32(chunk)]), keys: [W(payer, true), R(pool), W(this.sharesPda(pool, owner, authority, chunk)), R(SYS)] }); }
  /// Instructions creating any missing bin arrays / share accounts for `ids` (anyone may pay for them).
  async ensureBinAccountsIxs(payer, pool, ids, owner, authority) {
    const ixs = []; const chunks = [...new Set(ids.map(chunkOf))];
    for (const c of chunks) { if (!(await this.conn.getAccountInfo(this.binArrayPda(pool, c)))) ixs.push(this.initBinArrayIx(payer, pool, c));
      if (owner && !(await this.conn.getAccountInfo(this.sharesPda(pool, owner, authority, c)))) ixs.push(this.initSharesIx(payer, pool, owner, authority, c)); }
    return ixs; }
  /// Remaining accounts for bin instructions: the arrays of `ids` (+ `extraChunks`, e.g. the active bin's, passed even when
  /// that array does not exist yet) and, with `owner`, the (owner, authority) share accounts of the ids' chunks.
  binRemaining(pool, ids, owner, authority, extraChunks = []) { const chunks = [...new Set(ids.map(chunkOf))]; const all = [...new Set([...chunks, ...extraChunks])];
    const keys = all.map((c) => W(this.binArrayPda(pool, c))); if (owner) keys.push(...chunks.map((c) => W(this.sharesPda(pool, owner, authority, c)))); return keys; }
  binIx(name, data, keys) { return new TransactionInstruction({ programId: this.programs.bin, data: Buffer.concat([disc(name), ...data]), keys }); }
  /// Accounts of veyl_bin's MintLiquidity (tokens in from `from`) / BurnLiquidity (tokens out, signed by `authority`).
  mintKeys(from, pool, p, fromX, fromY) { return [R(from, true), W(pool), R(p.mintX), R(p.mintY), W(p.vaultX), W(p.vaultY), W(fromX || this.ata(p.mintX, from, p.tokenProgramX)), W(fromY || this.ata(p.mintY, from, p.tokenProgramY)), R(p.tokenProgramX), R(p.tokenProgramY)]; }
  burnKeys(authority, pool, p, toX, toY) { return [R(authority, true), W(pool), R(p.mintX), R(p.mintY), W(p.vaultX), W(p.vaultY), W(toX || this.ata(p.mintX, authority, p.tokenProgramX)), W(toY || this.ata(p.mintY, authority, p.tokenProgramY)), R(p.tokenProgramX), R(p.tokenProgramY)]; }
  async mintIx(from, pool, { owner = from, authority = owner, ids, amountsX, amountsY, minShares = [], deadline, fromX, fromY }) { const p = await this.binPool(pool);
    return this.binIx('mint', [pk(owner), pk(authority), vec(ids, i32), vec(amountsX, u64), vec(amountsY, u64), vec(minShares, u128), i64(deadline ?? Math.floor(Date.now() / 1000) + 600)], [...this.mintKeys(from, pool, p, fromX, fromY), ...this.binRemaining(pool, ids, owner, authority, [chunkOf(p.activeId)])]); }
  async burnIx(authority, pool, { owner = authority, ids, shares, toX, toY }) { const p = await this.binPool(pool);
    return this.binIx('burn', [pk(owner), vec(ids, i32), vec(shares, u128)], [...this.burnKeys(authority, pool, p, toX, toY), ...this.binRemaining(pool, ids, owner, authority, [chunkOf(p.activeId)])]); }
  async swapIx(user, pool, xForY, amountIn, minOut = 0n, p, arrays = SWAP_ARRAYS) { p = p || (await this.binPool(pool)); const [min_, mout] = xForY ? [p.mintX, p.mintY] : [p.mintY, p.mintX]; const [tin, tout] = xForY ? [p.tokenProgramX, p.tokenProgramY] : [p.tokenProgramY, p.tokenProgramX];
    return this.binIx('swap', [u8(xForY ? 1 : 0), u64(amountIn), u64(minOut)], [
      R(user, true), W(pool), R(p.mintX), R(p.mintY), W(p.vaultX), W(p.vaultY), W(this.ata(min_, user, tin)), W(this.ata(mout, user, tout)), R(p.tokenProgramX), R(p.tokenProgramY), ...chunksForSwap(p, xForY, arrays).map((c) => W(this.binArrayPda(pool, c)))]); }
  /// On-chain quote through simulateTransaction (return data = out u64, fee u64, endId i32).
  async quote(pool, xForY, amountIn, arrays = SWAP_ARRAYS) { const p = await this.binPool(pool); const payer = this.payer ? this.payer.publicKey : p.factory;
    const ix = this.binIx('quote', [u8(xForY ? 1 : 0), u64(amountIn)], [R(pool), ...chunksForSwap(p, xForY, arrays).map((c) => R(this.binArrayPda(pool, c)))]);
    const tx = await this.tx([ix], payer, 1_400_000); const r = await this.conn.simulateTransaction(tx, undefined, false);
    if (r.value.err) throw new Error('quote failed: ' + JSON.stringify(r.value.err) + ' ' + (r.value.logs || []).filter((l) => /Error|error/.test(l)).join(' | '));
    const d = Buffer.from(r.value.returnData.data[0], 'base64'); const rd = new Reader(d); return { out: rd.u64(), fee: rd.u64(), endId: rd.i32() }; }
  /// Local quote: the same maths in JavaScript, from the current bin arrays (the same ones a swap would get).
  async quoteLocal(pool, xForY, amountIn, now, arrays = SWAP_ARRAYS) { const p = await this.binPool(pool); const bins = await this.bins(pool, chunksForSwap(p, xForY, arrays)); return simulateSwap(p, bins, xForY, amountIn, now); }
  async currentFee(pool, now = Math.floor(Date.now() / 1000)) { const p = await this.binPool(pool); const { ref, iref } = refsOf(p, now); return feeOf(p, accOf(ref, iref, p.activeId)); }
  // fees, rewards, limit orders, rebalance, zap (public variants)
  async claimFeesIx(authority, pool, { owner = authority, ids, toX, toY }) { const p = await this.binPool(pool);
    return this.binIx('claim_fees', [pk(owner), vec(ids, i32)], [...this.burnKeys(authority, pool, p, toX, toY), ...this.binRemaining(pool, ids, owner, authority)]); }
  async claimRewardIx(authority, pool, { owner = authority, index, ids, to }) { const p = await this.binPool(pool); const r = p.rewards[index];
    return this.binIx('claim_reward', [pk(owner), u8(index), vec(ids, i32)], [R(authority, true), W(pool), R(r.mint), W(r.vault), W(to || this.ata(r.mint, authority, r.tokenProgram)), R(r.tokenProgram), ...this.binRemaining(pool, ids, owner, authority, [chunkOf(p.activeId)])]); }
  async placeOrderIx(from, pool, { owner = from, authority = owner, id, isAsk, amount, deadline, fromX, fromY }) { const p = await this.binPool(pool);
    return this.binIx('place_limit_order', [pk(owner), pk(authority), i32(id), u8(isAsk ? 1 : 0), u64(amount), i64(deadline ?? Math.floor(Date.now() / 1000) + 600)], [...this.mintKeys(from, pool, p, fromX, fromY), ...this.binRemaining(pool, [id], owner, authority)]); }
  async withdrawOrderIx(authority, pool, { owner = authority, id, isAsk, shares, toX, toY }) { const p = await this.binPool(pool);
    return this.binIx('withdraw_limit_order', [pk(owner), i32(id), u8(isAsk ? 1 : 0), u128(shares)], [...this.burnKeys(authority, pool, p, toX, toY), ...this.binRemaining(pool, [id], owner, authority)]); }
  async rebalanceIx(authority, pool, { owner = authority, burnIds, burnShares, ids, weightsX, weightsY, minShares = [], withholdBps = 0, deadline, toX, toY }) { const p = await this.binPool(pool);
    return this.binIx('rebalance_position', [pk(owner), vec(burnIds, i32), vec(burnShares, u128), vec(ids, i32), vec(weightsX, u16), vec(weightsY, u16), vec(minShares, u128), u16(withholdBps), i64(deadline ?? Math.floor(Date.now() / 1000) + 600)],
      [...this.burnKeys(authority, pool, p, toX, toY), ...this.binRemaining(pool, [...burnIds, ...ids], owner, authority, [chunkOf(p.activeId)])]); }
  /// Remaining accounts of a zap: the swap path's arrays, the new bins' arrays and the share accounts.
  zapRemaining(pool, p, xIn, ids, owner, authority, arrays = SWAP_ARRAYS) { return this.binRemaining(pool, ids, owner, authority, chunksForSwap(p, xIn, arrays)); }
  async swapAndAddIx(from, pool, { owner = from, authority = owner, xIn, amountIn, swapAmount = 0n, minSwapOut = 0n, ids, weightsX, weightsY, minShares = [], deadline, fromX, fromY }) { const p = await this.binPool(pool);
    return this.binIx('swap_and_add', [pk(owner), pk(authority), u8(xIn ? 1 : 0), u64(amountIn), u64(swapAmount), u64(minSwapOut), vec(ids, i32), vec(weightsX, u16), vec(weightsY, u16), vec(minShares, u128), i64(deadline ?? Math.floor(Date.now() / 1000) + 600)],
      [...this.mintKeys(from, pool, p, fromX, fromY), ...this.zapRemaining(pool, p, xIn, ids, owner, authority)]); }
  /// Plan a zap with the JS twin: how much of `amountIn` to swap so the two sides match the weights' X:Y value split
  /// (bisection on the swap amount), the expected swap output, amounts per bin and the shares each bin gives now.
  /// `slippageBps` sets minSwapOut and minShares below the expected figures.
  async planZap(pool, { xIn, amountIn, ids, weightsX, weightsY, slippageBps = 100, now = Math.floor(Date.now() / 1000) }) {
    pool = new PublicKey(pool); const p = await this.binPool(pool); const A = BigInt(amountIn); const swapBins = await this.bins(pool, chunksForSwap(p, xIn));
    const wx = weightsX.reduce((a, x) => a + BigInt(x), 0n), wy = weightsY.reduce((a, x) => a + BigInt(x), 0n);
    // value moves to the other side in proportion to its weight (equal weights = equal value per bin)
    const wIn = xIn ? wx : wy, wOut = xIn ? wy : wx; const swap = wOut === 0n ? 0n : wIn === 0n ? A : (A * wOut) / (wIn + wOut);
    const sim = swap > 0n ? simulateSwap(p, swapBins, xIn, swap, now) : { out: 0n, endId: p.activeId, touched: [] };
    const refs = refsOf(p, now); const p2 = swap > 0n ? { ...p, activeId: sim.endId, lastSwapAt: BigInt(now), volRef: refs.ref, idRef: refs.iref, volAcc: sim.volAcc } : p;
    const tx = xIn ? A - swap : sim.out, ty = xIn ? sim.out : A - swap; const sw = sideWeights(ids, weightsX, weightsY, sim.endId);
    const ax = distribute(tx, sw.weightsX), ay = distribute(ty, sw.weightsY);
    const bins = await this.bins(pool, [...new Set([...ids.map(chunkOf), ...swapBins.chunks])]); for (const t of sim.touched) bins.set(t.id, t);
    const r2 = refsOf(p2, now); const fee = feeOf(p2, accOf(r2.ref, r2.iref, p2.activeId));
    const shares = ids.map((id, i) => (ax[i] === 0n && ay[i] === 0n ? 0n : sharesForMint(p2, bins.get(id) || EMPTY_BIN, id, p2.activeId, ax[i], ay[i], fee)));
    const cut = (v) => v - (v * BigInt(slippageBps)) / 10_000n; const protocolFee = swap > 0n ? protocolFeeOf(swap, p.protocolFeeBps === undefined ? PROTOCOL_FEE_BPS : p.protocolFeeBps) : 0n;
    return { swapAmount: swap, swapOut: sim.out, minSwapOut: cut(sim.out), activeAfter: sim.endId, amountsX: ax, amountsY: ay, expectedShares: shares, minShares: shares.map(cut), lpFee: swap > 0n ? sim.lpFee : 0n, protocolFee }; }
  // protocol fee + rewards administration
  async withdrawProtocolFeeIx(feeAuthority, pool, amountX, amountY, toX, toY) { const p = await this.binPool(pool);
    return this.binIx('withdraw_protocol_fee', [u64(amountX), u64(amountY)], [R(feeAuthority, true), R(this.factoryPda()), W(pool), R(p.mintX), R(p.mintY), W(p.vaultX), W(p.vaultY), W(toX || this.ata(p.mintX, feeAuthority, p.tokenProgramX)), W(toY || this.ata(p.mintY, feeAuthority, p.tokenProgramY)), R(p.tokenProgramX), R(p.tokenProgramY)]); }
  proposeFeeAuthorityIx(feeAuthority, next) { return this.binIx('propose_fee_authority', [pk(next)], [R(feeAuthority, true), W(this.factoryPda())]); }
  acceptFeeAuthorityIx(next) { return this.binIx('accept_fee_authority', [], [R(next, true), W(this.factoryPda())]); }
  async initRewardIx(authority, pool, index, rewardMint, duration, funder) { const tp = await this.tokenProgram(rewardMint);
    return this.binIx('init_reward', [u8(index), u64(duration), pk(funder)], [W(authority, true), R(this.factoryPda()), W(pool), R(rewardMint), W(this.rewardVaultPda(pool, index)), R(tp), R(SYS)]); }
  async fundRewardIx(funder, pool, index, amount, from) { const p = await this.binPool(pool); const r = p.rewards[index];
    return this.binIx('fund_reward', [u8(index), u64(amount)], [R(funder, true), W(pool), R(r.mint), W(r.vault), W(from || this.ata(r.mint, funder, r.tokenProgram)), R(r.tokenProgram), W(this.binArrayPda(pool, chunkOf(p.activeId)))]); }
  setRewardFunderIx(funder, pool, index, next) { return this.binIx('set_reward_funder', [u8(index), pk(next)], [R(funder, true), W(pool)]); }
  async withdrawIneligibleRewardIx(funder, pool, index, to) { const p = await this.binPool(pool); const r = p.rewards[index];
    return this.binIx('withdraw_ineligible_reward', [u8(index)], [R(funder, true), W(pool), R(r.mint), W(r.vault), W(to || this.ata(r.mint, funder, r.tokenProgram)), R(r.tokenProgram), W(this.binArrayPda(pool, chunkOf(p.activeId)))]); }

  // ---- veyl_entry instructions
  initEntryIx(payer) { return new TransactionInstruction({ programId: this.programs.entry, data: disc('init_entry'), keys: [W(payer, true), W(this.entryPda()), R(this.signerPda()), R(SYS)] }); }
  async initVaultIx(payer, mint) { const tp = await this.tokenProgram(mint);
    return new TransactionInstruction({ programId: this.programs.entry, data: disc('init_vault'), keys: [W(payer, true), R(this.entryPda()), R(this.signerPda()), R(mint), W(this.ata(mint, this.signerPda(), tp)), R(tp), R(ATA_PROGRAM), R(SYS)] }); }
  async relayIx(relayer, mint, nullifierHash, d) { const pool = this.poolPda(mint); const p = await this.pool(pool);
    return new TransactionInstruction({ programId: this.programs.entry, data: Buffer.concat([disc('relay'), DATA.relay(d)]), keys: [
      W(relayer, true), R(this.entryPda()), R(this.signerPda()), W(pool), R(mint), W(p.vault), W(this.spendPda(pool, nullifierHash)), W(this.ata(mint, this.signerPda(), p.tokenProgram)),
      W(this.ata(mint, d.feeRecipient, p.tokenProgram)), W(this.ata(mint, d.recipient, p.tokenProgram)), R(p.tokenProgram), R(this.programs.pool)] }); }
  /// Remaining accounts for a route (per hop: bin pool, mints, vaults, token programs, `who`'s output token account, bin arrays).
  async routeRemaining(routes, who) { const keys = [];
    for (const r of routes) for (const h of r.hops) { const p = await this.binPool(h.pool); const outMint = h.xForY ? p.mintY : p.mintX; const outTp = h.xForY ? p.tokenProgramY : p.tokenProgramX; const chunks = chunksForSwap(p, h.xForY);
      h.nArrays = chunks.length; keys.push(W(h.pool), R(p.mintX), R(p.mintY), W(p.vaultX), W(p.vaultY), R(p.tokenProgramX), R(p.tokenProgramY), W(this.ata(outMint, who, outTp)), ...chunks.map((c) => W(this.binArrayPda(h.pool, c)))); }
    return keys; }
  /// Fills `nArrays` on every hop (must be done before the proof context is computed).
  async prepareRoutes(routes) { for (const r of routes) for (const h of r.hops) { const p = await this.binPool(h.pool); h.nArrays = chunksForSwap(p, h.xForY).length; } return routes; }
  async privateSwapIx(relayer, mintIn, nullifierHash, d) { const poolIn = this.poolPda(mintIn), poolOut = this.poolPda(d.tokenOut); const pin = await this.pool(poolIn), pout = await this.pool(poolOut); const signer = this.signerPda();
    const payoutToken = d.recipient ? this.ata(d.tokenOut, d.recipient, pout.tokenProgram) : this.ata(d.tokenOut, signer, pout.tokenProgram);
    const record = this.depositPda(poolOut, labelOf(poolOut, pout.depositNonce + 1n));
    return new TransactionInstruction({ programId: this.programs.entry, data: Buffer.concat([disc('private_swap'), DATA.swap(d)]), keys: [
      W(relayer, true), R(this.entryPda()), R(signer), W(poolIn), R(mintIn), W(pin.vault), W(this.spendPda(poolIn, nullifierHash)), W(this.ata(mintIn, signer, pin.tokenProgram)), W(this.ata(mintIn, d.feeRecipient, pin.tokenProgram)),
      R(d.tokenOut), W(this.ata(d.tokenOut, signer, pout.tokenProgram)), W(payoutToken), W(poolOut), W(pout.vault), W(record), R(pin.tokenProgram), R(pout.tokenProgram), R(this.programs.pool), R(this.programs.bin), R(SYS),
      ...(await this.routeRemaining(d.routes, signer))] }); }
  /// legs: [{ mint, nullifierHash }] (1 or 2). Share accounts for (owner, entry signer) must exist (ensureBinAccountsIxs).
  async privateAddIx(relayer, legs, d) { const bp = await this.binPool(d.binPool); const signer = this.signerPda(); const legKeys = [];
    for (const l of legs) { const pool = this.poolPda(l.mint); const p = await this.pool(pool); legKeys.push(W(pool), W(p.vault), W(this.spendPda(pool, l.nullifierHash))); }
    return new TransactionInstruction({ programId: this.programs.entry, data: Buffer.concat([disc('private_add'), DATA.add(d), u8(legs.length)]), keys: [
      W(relayer, true), R(this.entryPda()), R(signer), W(d.binPool), R(bp.mintX), R(bp.mintY), W(bp.vaultX), W(bp.vaultY), W(this.ata(bp.mintX, signer, bp.tokenProgramX)), W(this.ata(bp.mintY, signer, bp.tokenProgramY)),
      W(this.ata(bp.mintX, d.feeRecipient, bp.tokenProgramX)), W(this.ata(bp.mintY, d.feeRecipient, bp.tokenProgramY)), R(bp.tokenProgramX), R(bp.tokenProgramY), R(this.programs.pool), R(this.programs.bin),
      ...legKeys, ...this.binRemaining(d.binPool, d.ids, d.owner, signer, [chunkOf(bp.activeId)])] }); }
  /// The ed25519 instruction that must precede private_remove: the one-time key's signature over removeDigest(d).
  removeSigIx(ownerPubkey, signature, d) { return this.signedSigIx('remove', ownerPubkey, signature, d); }
  /// The ed25519 instruction for any signed position action (remove | claim | reward | orderWithdraw | rebalance).
  signedSigIx(kind, ownerPubkey, signature, d) { return Ed25519Program.createInstructionWithPublicKey({ publicKey: new PublicKey(ownerPubkey).toBytes(), message: signedDigest(kind, this.programs.entry, d), signature }); }
  /// Sign a position action with its one-time key (a tweetnacl / web3 Keypair secret key), for the relayer.
  signAction(kind, ownerSecretKey, d) { const nacl = require('tweetnacl'); return Buffer.from(nacl.sign.detached(signedDigest(kind, this.programs.entry, d), Uint8Array.from(ownerSecretKey))); }
  /// Accounts of veyl_entry's PrivateRemove (shared by every signed position action), then `rem`.
  async positionKeys(relayer, d, rem) { const bp = await this.binPool(d.binPool); const signer = this.signerPda(); const poolX = this.poolPda(bp.mintX), poolY = this.poolPda(bp.mintY); const px = await this.pool(poolX), py = await this.pool(poolY);
    const recX = this.depositPda(poolX, labelOf(poolX, px.depositNonce + 1n)), recY = this.depositPda(poolY, labelOf(poolY, py.depositNonce + 1n));
    const payX = d.recipient ? this.ata(bp.mintX, d.recipient, bp.tokenProgramX) : this.ata(bp.mintX, signer, bp.tokenProgramX), payY = d.recipient ? this.ata(bp.mintY, d.recipient, bp.tokenProgramY) : this.ata(bp.mintY, signer, bp.tokenProgramY);
    return [W(relayer, true), R(this.entryPda()), R(signer), R(SYSVAR_INSTRUCTIONS_PUBKEY), W(this.noncePda(d.owner)), W(d.binPool), R(bp.mintX), R(bp.mintY), W(bp.vaultX), W(bp.vaultY), W(this.ata(bp.mintX, signer, bp.tokenProgramX)), W(this.ata(bp.mintY, signer, bp.tokenProgramY)),
      W(this.ata(bp.mintX, d.feeRecipient, bp.tokenProgramX)), W(this.ata(bp.mintY, d.feeRecipient, bp.tokenProgramY)), W(poolX), W(px.vault), W(recX), W(poolY), W(py.vault), W(recY), W(payX), W(payY),
      R(bp.tokenProgramX), R(bp.tokenProgramY), R(this.programs.pool), R(this.programs.bin), R(SYS), ...rem]; }
  entryIx(name, data, keys) { return new TransactionInstruction({ programId: this.programs.entry, data: Buffer.concat([disc(name), data]), keys }); }
  async privateRemoveIx(relayer, d) { const bp = await this.binPool(d.binPool);
    return this.entryIx('private_remove', DATA.remove(d), await this.positionKeys(relayer, d, this.binRemaining(d.binPool, d.ids, d.owner, this.signerPda(), [chunkOf(bp.activeId)]))); }
  async privateClaimFeesIx(relayer, d) { return this.entryIx('private_claim_fees', DATA.claim(d), await this.positionKeys(relayer, d, this.binRemaining(d.binPool, d.ids, d.owner, this.signerPda()))); }
  async privateWithdrawOrderIx(relayer, d) { return this.entryIx('private_withdraw_order', DATA.orderWithdraw(d), await this.positionKeys(relayer, d, this.binRemaining(d.binPool, [d.id], d.owner, this.signerPda()))); }
  async privateRebalanceIx(relayer, d) { const bp = await this.binPool(d.binPool);
    return this.entryIx('private_rebalance', DATA.rebalance(d), await this.positionKeys(relayer, d, this.binRemaining(d.binPool, [...d.burnIds, ...d.ids], d.owner, this.signerPda(), [chunkOf(bp.activeId)]))); }
  async privateClaimRewardIx(relayer, d) { const bp = await this.binPool(d.binPool); const r = bp.rewards[d.index]; const signer = this.signerPda(); const pool = this.poolPda(r.mint); const pp = await this.pool(pool);
    const rec = pp ? this.depositPda(pool, labelOf(pool, pp.depositNonce + 1n)) : SYS; const pay = d.recipient ? this.ata(r.mint, d.recipient, r.tokenProgram) : this.ata(r.mint, signer, r.tokenProgram);
    return this.entryIx('private_claim_reward', DATA.reward(d), [W(relayer, true), R(this.entryPda()), R(signer), R(SYSVAR_INSTRUCTIONS_PUBKEY), W(this.noncePda(d.owner)), W(d.binPool), R(r.mint), W(r.vault), W(this.ata(r.mint, signer, r.tokenProgram)),
      W(this.ata(r.mint, d.feeRecipient, r.tokenProgram)), W(pool), W(pp ? pp.vault : SYS), W(rec), W(pay), R(r.tokenProgram), R(this.programs.pool), R(this.programs.bin), R(SYS), ...this.binRemaining(d.binPool, d.ids, d.owner, signer, [chunkOf(bp.activeId)])]); }
  /// Accounts of veyl_entry's PrivateAdd for one leg (place order, zap), then `rem`.
  async addKeys(relayer, binPool, feeRecipient, leg, rem) { const bp = await this.binPool(binPool); const signer = this.signerPda(); const pool = this.poolPda(leg.mint); const p = await this.pool(pool);
    return [W(relayer, true), R(this.entryPda()), R(signer), W(binPool), R(bp.mintX), R(bp.mintY), W(bp.vaultX), W(bp.vaultY), W(this.ata(bp.mintX, signer, bp.tokenProgramX)), W(this.ata(bp.mintY, signer, bp.tokenProgramY)),
      W(this.ata(bp.mintX, feeRecipient, bp.tokenProgramX)), W(this.ata(bp.mintY, feeRecipient, bp.tokenProgramY)), R(bp.tokenProgramX), R(bp.tokenProgramY), R(this.programs.pool), R(this.programs.bin),
      W(pool), W(p.vault), W(this.spendPda(pool, leg.nullifierHash)), ...rem]; }
  /// leg: { mint (X for an ask, Y for a bid), nullifierHash }.
  async privatePlaceOrderIx(relayer, leg, d) { return this.entryIx('private_place_order', DATA.order(d), await this.addKeys(relayer, d.binPool, d.feeRecipient, leg, this.binRemaining(d.binPool, [d.id], d.owner, this.signerPda()))); }
  async privateZapIx(relayer, leg, d) { const bp = await this.binPool(d.binPool);
    return this.entryIx('private_zap', DATA.zap(d), await this.addKeys(relayer, d.binPool, d.feeRecipient, leg, this.zapRemaining(d.binPool, bp, d.xIn, d.ids, d.owner, this.signerPda()))); }
  /// The public router: swap_route(tokenIn, tokenOut, routes, minOut, deadline) signed by the user.
  async swapRouteIx(user, tokenIn, tokenOut, routes, minOut, deadline = Math.floor(Date.now() / 1000) + 600) { const tpi = await this.tokenProgram(tokenIn), tpo = await this.tokenProgram(tokenOut);
    const rem = await this.routeRemaining(routes, user);
    return new TransactionInstruction({ programId: this.programs.entry, data: Buffer.concat([disc('swap_route'), pk(tokenIn), pk(tokenOut), vec(routes, encRoute), u64(minOut), i64(deadline)]), keys: [
      R(user, true), W(this.ata(tokenIn, user, tpi)), W(this.ata(tokenOut, user, tpo)), R(this.programs.bin), ...rem] }); }

  // ---- the pool's history, from the chain (what the relayer serves and the engine verifies against the current root)
  /// All Deposited / Withdrawn events of a pool, oldest first, by walking its signatures and parsing the logs. Only events
  /// the pool program logged count: any program can log a look-alike "Program data:" line in a transaction that merely
  /// mentions the pool, and a forged Deposited could put a denylisted deposit's label in the approved set or break the tree.
  async poolHistory(pool) {
    const addr = new PublicKey(pool); const prog = new PublicKey(this.programs.pool).toBase58(); let before; const sigs = [];
    for (;;) { const page = await this.conn.getSignaturesForAddress(addr, { before, limit: 1000 }, 'confirmed'); sigs.push(...page); if (page.length < 1000) break; before = page[page.length - 1].signature; }
    sigs.reverse(); const out = [];
    for (const s of sigs) { if (s.err) continue; const t = await this.conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (!t) continue;
      for (const e of logEvents(t.meta.logMessages)) if ((e.name === 'Deposited' || e.name === 'Withdrawn') && e.program === prog && e.pool.equals(addr)) { delete e.program; out.push({ ...e, sig: s.signature, slot: s.slot }); } }
    return out;
  }
  /// Leaves in tree order (index), plus every deposit (label, payer, beneficiary) for screening.
  async readTree(pool) {
    const hist = await this.poolHistory(pool); const leaves = []; const deposits = [];
    for (const e of hist) { const i = Number(e.index); leaves[i] = e.name === 'Deposited' ? e.commitment : e.newCommitment; if (e.name === 'Deposited') deposits.push({ label: e.label, payer: e.payer, beneficiary: e.beneficiary, value: e.value, index: i, commitment: e.commitment, precommitment: e.precommitment }); }
    for (let i = 0; i < leaves.length; i++) if (leaves[i] === undefined) throw new Error('gap in the tree history at ' + i);
    return { leaves, deposits };
  }
}
module.exports = { W, R, encRoute, packProofN, strings, Veyl, Reader, TOKEN_PROGRAM, TOKEN_2022, ATA_PROGRAM, SYS, BPF_UPGRADEABLE_LOADER, SIZES, rentOf, F, Q, STATE_DEPTH, ASP_DEPTH, ROOT_HISTORY, ASP_HISTORY, BINS_PER_ARRAY, PIPS, MAX_FEE, MIN_LIQUIDITY, MAX_FEE_BPS, ACTION, DEFAULT_TTL_SLOTS,
  CHUNKS, MIN_CHUNK, MIN_BIN_ID, MAX_BIN_ID, MAX_IDS, PROTOCOL_FEE_BPS, MAX_TIERS, DEFAULT_FEE_TIERS, protocolFeeOf, canonicalPair, usableLut, NUM_REWARDS, SWAP_ARRAYS, TAGS, vfcFromMeteora, vfcToMeteora, U128,
  disc, u8, u16, u32, i32, u64, i64, u128, be32, fromBe32, pk, vec, opt, big, j, feeBpsFor, H, hashToField, labelOf, contextOf, rand, zeros, merklePath, packProof, withdrawInput, newNote, DATA, encodeAction, removeDigest, signedDigest, parseEvents, logEvents, EVENT_IX_TAG, parseEventData,
  mulDiv, mulDivCeil, stepQ, priceOf, feeOf, accOf, refsOf, simulateSwap, sharesForMint, chunkOf, slotOf, chunksForSwap, chunkBit, nextChunk, nextBin, liveChunks, owedOf, pendingRewardGrowth, distribute, sideWeights, shapeWeights, EMPTY_BIN,
  decodeBinPool, decodeBinArray, decodeShareAccount, decodeFactory, decodeBond, MINT_EXT, MINT_EXT_OK, parseMint, refusedExtensions, priceQ, tierCategory, tierLabel, BIN_POOL_DISC };
