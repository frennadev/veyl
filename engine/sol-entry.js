// Veyl browser engine for Solana: wallet, notes, trees, proofs, relayer. Bundled by esbuild into veyl-sol.js (window.Veyl).
// Port of web/engine.src.js: the proving code (snarkjs, same circuit / zkey) is unchanged; only the chain layer differs.
// Everything private happens on this device: note secrets, Merkle paths, zero-knowledge proofs. The relayer sends.
import { Buffer } from 'buffer'; if (typeof window !== 'undefined' && !window.Buffer) window.Buffer = Buffer;
import { Connection, PublicKey, Keypair, Transaction, ComputeBudgetProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import nacl from 'tweetnacl';
const S = require('../sdk/veyl.js');
const { Veyl, H, rand, merklePath, packProof, withdrawInput, newNote, encodeAction, contextOf, removeDigest, signedDigest, STATE_DEPTH, ASP_DEPTH, priceOf, chunkOf, slotOf, j, shapeWeights, sideWeights, distribute, sharesForMint, EMPTY_BIN, MIN_LIQUIDITY } = S;
const snarkjs = () => { if (!window.snarkjs) throw new Error('snarkjs is not loaded'); return window.snarkjs; };
const Z = require('../sdk/shield.js');
import { walletList, onWallets, waitForWallet, setChain } from './wallets.js';
import { installShield } from './shield-engine.js';
import { installSealed } from './sealed-engine.js';
import { installPools, PoolError } from './pools-engine.js';
import { Market, parsePyth, parseJupiter, parseCandles, ORIGINS as MARKET_ORIGINS } from './market.js';
import { Markets, SOURCES as MARKET_SOURCES, ORIGINS as MARKETS_ORIGINS, mergeRows } from './markets.js';

class PrivacyError extends Error {}
const b58 = (k) => new PublicKey(k).toBase58();
const WSOL = 'So11111111111111111111111111111111111111112', FEE_RESERVE = 5_000_000n; // 0.005 SOL kept for network fees

// ------------------------------------------------------------- note store (this device only)
class Store {
  constructor(key) { this.key = key; this.data = Store.empty(); this.ok = true; this.load(); }
  static empty() { return { notes: [], positions: [], orders: [], activity: [], shield: { orders: [], pending: [], meta: {} } }; }
  static norm(d) { const e = Store.empty(); for (const k of Object.keys(e)) { if (k === 'shield') { if (!d.shield || typeof d.shield !== 'object') d.shield = e.shield; continue; } if (!Array.isArray(d[k])) d[k] = e[k]; } return d; }
  load() { try { const s = localStorage.getItem(this.key); if (s) this.data = Store.norm(JSON.parse(s)); } catch { this.ok = false; } }
  save() { try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch { this.ok = false; } }
  export() { return JSON.stringify(this.data, null, 1); }
  /// Merge a backup into what this device holds: nothing already here is dropped or overwritten by an older copy.
  merge(d) { if (!d || !Array.isArray(d.notes)) throw new Error('That file is not a Veyl backup.'); Store.norm(d); const cur = this.data; let added = 0;
    // one shielded account per browser: a backup of another account restores only where this one was never used
    { const s = cur.shield || {}; const used = !!s.seed && ((s.ot > 0) || (s.orders || []).length || (s.pending || []).length || s.used);
      if (d.shield && d.shield.seed && s.seed && s.seed !== d.shield.seed && used) throw new Error('This browser already holds another shielded account that has been used. Export it first, then restore this backup in a fresh browser profile.'); }
    const nk = (n) => n.precommitment || n.commitment || n.nullifier;
    for (const n of d.notes) { const have = cur.notes.find((m) => nk(m) === nk(n)); if (!have) { cur.notes.push(n); added++; } else { if (n.spent) have.spent = true; if (have.index === undefined && n.index !== undefined) Object.assign(have, { index: n.index, label: n.label, value: n.value }); } }
    for (const k of ['positions', 'orders']) for (const x of d[k]) if (!cur[k].some((y) => y.id === x.id)) { cur[k].push(x); added++; }
    for (const a of d.activity) if (!cur.activity.some((b) => b.ts === a.ts && b.t === a.t)) cur.activity.push(a);
    // Phase 2: the shielded account is its seed; its notes are restored from the chain by scanning. An unused local seed is
    // replaced by the backup's (a used one refuses the restore, above).
    if (d.shield && d.shield.seed) { const s = cur.shield || (cur.shield = { orders: [], pending: [], meta: {} });
      if (s.seed !== d.shield.seed) { s.seed = d.shield.seed; added++; } // checked above: the local account is unused
      s.ot = Math.max(s.ot || 0, d.shield.seed === s.seed ? d.shield.ot || 0 : 0);
      for (const o of d.shield.orders || []) if (!(s.orders || []).some((x) => x.id === o.id)) (s.orders = s.orders || []).push(o);
      s.meta = { ...(d.shield.meta || {}), ...(s.meta || {}) }; }
    if (Array.isArray(d.depositKey) && !Array.isArray(cur.depositKey)) { cur.depositKey = d.depositKey; cur.useLocal = !!d.useLocal; added++; }
    cur.activity.sort((a, b) => b.ts - a.ts); this.save(); return added; }
  import(text) { return this.merge(JSON.parse(text)); }
}

// ------------------------------------------------------------- encrypted backups (PBKDF2-SHA256 -> AES-256-GCM, WebCrypto)
const B64 = (u) => Buffer.from(u).toString('base64'); const UB64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
const KDF_ITER = 310_000;
async function kdf(pass, salt, iter) { const c = globalThis.crypto.subtle; const base = await c.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return c.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
export async function encryptBackup(plain, pass) { if (!pass || pass.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16)), iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await kdf(pass, salt, KDF_ITER), new TextEncoder().encode(plain));
  return JSON.stringify({ veyl: 'backup', v: 1, kdf: 'PBKDF2-SHA256', iter: KDF_ITER, cipher: 'AES-256-GCM', salt: B64(salt), iv: B64(iv), ct: B64(new Uint8Array(ct)), createdAt: new Date().toISOString() }); }
export async function decryptBackup(text, pass) { let o; try { o = JSON.parse(text); } catch { throw new Error('That file is not a Veyl backup.'); }
  if (Array.isArray(o.notes)) return text; // an older, unencrypted backup
  if (o.veyl !== 'backup' || !o.ct) throw new Error('That file is not a Veyl backup.');
  try { const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: UB64(o.iv) }, await kdf(pass, UB64(o.salt), o.iter), UB64(o.ct)); return new TextDecoder().decode(pt); }
  catch { throw new Error('Wrong passphrase, or the file was changed.'); } }

// ------------------------------------------------------------- engine
export class Engine {
  /// cfg = window.VEYL_CONFIG: { chainName, rpc, explorer, relayer, programs, zk:{wasm,zkey}, tokens:{SYM:{mint,decimals,pool}}, binPools:[...] }
  constructor(cfg) {
    this.cfg = cfg; this.conn = new Connection(cfg.rpc, 'confirmed');
    setChain(cfg.cluster); // Wallet Standard sign requests name this chain
    this.V = new Veyl({ connection: this.conn, programs: cfg.programs });
    this.store = new Store('veyl:sol:' + cfg.programs.entry);
    this.account = null; this.wallet = null; this.pk = null; this.onLog = () => {};
    this.tokens = cfg.tokens; // {SYM:{mint,decimals,pool}}
    this.market = new Market(); // live market prices (Pyth, then Jupiter), for dollar figures: never Veyl pool data
    try { this.shieldInit(); } catch { /* no crypto (very old browser): the shielded pool stays off */ }
    if (typeof window !== 'undefined') window.veylEngine = this; // the page's engine, for the console and the browser test
  }
  log(m) { try { this.onLog(m); } catch {} }
  // tok(symbol | mint), tokKey, symOf, tokLabel: pools-engine.js (every call that takes a token also takes its mint)
  unit(sym, v) { const d = this.tok(sym).decimals; const [i, f = ''] = String(v).split('.'); return BigInt(i || '0') * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d) || '0'); }
  fmt(sym, v) { return Number(BigInt(v)) / 10 ** this.tok(sym).decimals; }
  async ping() { return this.conn.getSlot('confirmed'); }

  // ---- wallet: every Wallet Standard wallet, then injected globals (engine/wallets.js)
  static wallets() { return walletList().map((p) => [p.name, p]); }
  static walletList() { return walletList(); }
  static onWallets(cb) { return onWallets(cb); }
  /// silent: reconnect only if the wallet already trusts this site (no prompt). The wallet's name is remembered for that.
  async connect(w, { silent = false } = {}) {
    w = w || walletList()[0]; if (!w) throw new Error('No Solana wallet found. Install Phantom, Solflare or Backpack, then reload.');
    const r = await w.connect(silent ? { silent: true } : undefined); this._unwatch?.();
    this.wallet = w; this.pk = new PublicKey(String((r && r.publicKey) || w.publicKey)); this.account = this.pk.toBase58();
    if (!w.isLocal) { this.isLocal = false; this.store.data.wallet = w.name || null; this.store.data.useLocal = false; this.store.save(); }
    this._unwatch = w.onChange ? w.onChange((a) => { if (!a) this.disconnect(); else { this.pk = new PublicKey(a); this.account = a; this._accountChanged(); } }) : null;
    return this.account;
  }
  /// The last wallet used here, without a prompt; null when it isn't installed or no longer trusts this site.
  async reconnect() { const name = this.store.data.wallet; if (!name || this.wallet) return null; const w = await waitForWallet(name); if (!w || this.wallet) return null; // gone, or connected some other way meanwhile
    try { return await this.connect(w, { silent: true }); } catch { return null; } }
  /// Forget the connection (the deposit address key stays in this browser, for "No wallet needed" to pick up again).
  async disconnect() { const w = this.wallet; this._unwatch?.(); this._unwatch = null; this.wallet = null; this.pk = null; this.account = null; this.isLocal = false;
    this.store.data.wallet = null; this.store.data.useLocal = false; this.store.save(); if (w && !w.isLocal) await w.disconnect?.(); this._accountChanged(); }
  /// cb(account | null) when the connected account changes from the wallet's side (switch account, disconnect).
  onAccount(cb) { (this._accountCbs ||= new Set()).add(cb); return () => this._accountCbs.delete(cb); }
  _accountChanged() { for (const cb of this._accountCbs || []) { try { cb(this.account); } catch { /* a listener's problem */ } } }
  async _send(ixs, cu = 400_000) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs);
    tx.feePayer = this.pk; tx.recentBlockhash = (await this.conn.getLatestBlockhash()).blockhash;
    const signed = await this.wallet.signTransaction(tx); const sig = await this.conn.sendRawTransaction(signed.serialize());
    const r = await this.conn.confirmTransaction(sig, 'confirmed'); if (r.value.err) throw new Error('Transaction failed on-chain.'); return sig;
  }
  async publicBalance(sym) { if (!this.pk) return 0n; const mint = new PublicKey(this.tok(sym).mint); const t = await this.V.tokenBalance(mint, this.pk);
    if (mint.toBase58() !== WSOL) return t; const lam = BigInt(await this.conn.getBalance(this.pk)); return t + (lam > FEE_RESERVE ? lam - FEE_RESERVE : 0n); } // SOL: wrapped + native, less a fee reserve
  /// Native SOL is wrapped on the way in: the pools hold wrapped SOL (an SPL token), wallets mostly hold native SOL.
  async wrapIxs(mint, v) { if (new PublicKey(mint).toBase58() !== WSOL) return []; const m = new PublicKey(WSOL); const tp = await this.V.tokenProgram(m);
    const have = await this.V.tokenBalance(m, this.pk); if (have >= v) return []; const ata = this.V.ata(m, this.pk, tp); const need = v - have;
    const lam = BigInt(await this.conn.getBalance(this.pk)); if (lam < need + FEE_RESERVE) throw new Error('Not enough SOL: keep about 0.005 SOL for network fees on top of the deposit.');
    return [this.ataIx(this.pk, m, this.pk, tp), SystemProgram.transfer({ fromPubkey: this.pk, toPubkey: ata, lamports: Number(need) }), new TransactionInstruction({ programId: tp, keys: [{ pubkey: ata, isSigner: false, isWritable: true }], data: Buffer.from([17]) })]; }
  // ---- no-wallet mode: a deposit address kept in this browser (backed up with the notes). Funded from any wallet or exchange.
  localKeypair() { const d = this.store.data; if (!Array.isArray(d.depositKey)) { d.depositKey = Array.from(Keypair.generate().secretKey); this.store.save(); } return Keypair.fromSecretKey(Uint8Array.from(d.depositKey)); }
  localAdapter() { const kp = this.localKeypair(); const sign = (tx) => { if (tx instanceof VersionedTransaction) tx.sign([kp]); else tx.partialSign(kp); return tx; };
    return { isLocal: true, publicKey: kp.publicKey, connect: async () => ({ publicKey: kp.publicKey }), signTransaction: async (tx) => sign(tx), signAllTransactions: async (txs) => txs.map(sign) }; }
  async connectLocal() { const a = await this.connect(this.localAdapter()); this.isLocal = true; this.store.data.useLocal = true; this.store.data.wallet = null; this.store.save(); return a; }
  async solBalanceOf() { return this.pk ? BigInt(await this.conn.getBalance(this.pk)) : 0n; }
  /// Empties the deposit address to `to`: every token, then the SOL left after fees (wrapped SOL is unwrapped first). Public.
  async localSweep(to) { if (!this.isLocal) throw new Error('Only the deposit address kept in this browser can be emptied from here.');
    const dest = new PublicKey(to); if (dest.equals(this.pk)) throw new Error('That is the deposit address itself.'); const ixs = []; const out = [];
    for (const sym of Object.keys(this.tokens)) { const mint = new PublicKey(this.tok(sym).mint); let tp; try { tp = await this.V.tokenProgram(mint); } catch { continue; }
      const src = this.V.ata(mint, this.pk, tp); if (!(await this.conn.getAccountInfo(src))) continue; const bal = await this.V.tokenBalance(mint, this.pk);
      if (mint.toBase58() !== WSOL && bal > 0n) { const amt = Buffer.alloc(8); amt.writeBigUInt64LE(bal); ixs.push(this.ataIx(this.pk, mint, dest, tp));
        ixs.push(new TransactionInstruction({ programId: tp, keys: [{ pubkey: src, isSigner: false, isWritable: true }, { pubkey: this.V.ata(mint, dest, tp), isSigner: false, isWritable: true }, { pubkey: this.pk, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([3]), amt]) })); out.push(sym); }
      ixs.push(new TransactionInstruction({ programId: tp, keys: [{ pubkey: src, isSigner: false, isWritable: true }, { pubkey: this.pk, isSigner: false, isWritable: true }, { pubkey: this.pk, isSigner: true, isWritable: false }], data: Buffer.from([9]) })); }
    const sigs = []; if (ixs.length) sigs.push(await this._send(ixs, 400_000));
    const lam = BigInt(await this.conn.getBalance(this.pk)); if (lam > 5000n) { sigs.push(await this._send([SystemProgram.transfer({ fromPubkey: this.pk, toPubkey: dest, lamports: Number(lam - 5000n) })], 20_000)); out.push('SOL'); }
    return { tx: sigs[sigs.length - 1] || null, moved: out }; }
  async solBalance() { return this.pk ? BigInt(await this.conn.getBalance(this.pk)) : 0n; }

  // ---- notes
  notes(sym) { const pool = this.tok(sym).pool; return this.store.data.notes.filter((n) => n.pool === pool && !n.spent && n.index !== undefined); }
  privateBalance(sym) { return this.notes(sym).reduce((s, n) => s + BigInt(n.value), 0n); }
  /// Resolve pending notes (created by a swap / remove before their Deposited event was seen) and mark spent ones.
  /// Notes are never deleted here: an unresolved note keeps its secrets until it resolves or is restored from a backup.
  async refreshNotes() {
    const byPool = {};
    for (const n of this.store.data.notes) {
      if (n.index === undefined || !n.spent) {
        if (!byPool[n.pool]) { try { byPool[n.pool] = await this.state(n.pool, false); } catch { continue; } }
        const st = byPool[n.pool];
        if (n.index === undefined) {
          if (n.commitment) { const i = st.leaves.findIndex((l) => String(l) === String(n.commitment)); if (i >= 0) n.index = i; } // a change note: its commitment is a leaf
          else { const d = st.deposits.find((x) => String(x.precommitment) === String(n.precommitment)); if (d) { n.index = d.index; n.label = String(d.label); n.value = String(d.value); } } // a deposit (swap / remove output)
        }
        if (n.index !== undefined && !n.spent) { if (await this.V.isSpent(new PublicKey(n.pool), H(BigInt(n.nullifier)))) n.spent = true; }
      }
    }
    this.store.save();
  }
  async deposit(sym, amount) {
    if (!this.pk) throw new Error('Connect a wallet first.');
    const t = this.tok(sym); const v = this.unit(sym, amount); const mint = new PublicKey(t.mint);
    const p = await this.V.pool(new PublicKey(t.pool)); if (!p) throw new Error('This pool is not deployed.');
    if (v < p.minDeposit) throw new Error('Minimum deposit is ' + this.fmt(sym, p.minDeposit) + ' ' + sym + '.');
    const sec = newNote();
    const note = { pool: t.pool, sym, nullifier: sec.nullifier, secret: sec.secret, precommitment: sec.precommitment, createdAt: Date.now() };
    this.store.data.notes.push(note); this.store.save(); // saved BEFORE sending, so a crash can't lose it
    this.log('Confirm the deposit in your wallet');
    const sig = await this._send([await this.V.depositIx(this.pk, mint, v, BigInt(sec.precommitment), this.pk)], 400_000);
    const ev = (await this.V.events(sig)).find((e) => e.name === 'Deposited' && String(e.precommitment) === sec.precommitment);
    if (ev) { note.index = Number(ev.index); note.label = ev.label.toString(); note.value = ev.value.toString(); } note.tx = sig;
    this.store.save();
    return note;
  }

  // ---- proofs
  /// Leaves + approved labels from the relayer (fast), verified against the chain (trust-minimised).
  async state(pool, verify = true) {
    const r = await fetch(this.cfg.relayer + '/state?pool=' + pool).then((x) => x.json()); if (r.error) throw new Error(r.error);
    r.leaves = r.leaves.map(BigInt); r.labels = r.labels.map(BigInt);
    if (verify) {
      const p = await this.V.pool(new PublicKey(pool));
      const st = merklePath(r.leaves.length ? r.leaves : [0n], 0, STATE_DEPTH); const asp = merklePath(r.labels.length ? r.labels : [0n], 0, ASP_DEPTH);
      if (st.root !== p.currentRoot) throw new Error("The relayer's view of the pool is out of date. Try again in a moment.");
      if (asp.root !== p.aspRoot) throw new Error('The approved list is being updated. Try again in a moment.');
    }
    return r;
  }
  async prove(note, withdrawnValue, kind, d) {
    const s = await this.state(note.pool);
    if (!s.labels.map(String).includes(String(note.label))) throw new PrivacyError('This deposit is not approved yet. It can still be taken back publicly (ragequit).');
    this.log('Finding your note in the pool');
    const ctx = contextOf(this.V.signerPda(), encodeAction(kind, d), new PublicKey(note.pool));
    const w = withdrawInput({ note, withdrawnValue, context: ctx, leaves: s.leaves, labels: s.labels });
    // the change note is saved BEFORE anything is sent, so a closed tab or a slow relayer cannot lose it
    const change = BigInt(w.changeNote.value) > 0n ? { pool: note.pool, sym: note.sym, ...w.changeNote, createdAt: Date.now(), pending: true } : null;
    if (change) { this.store.data.notes.push(change); this.store.save(); }
    this.log('Generating the proof on your device');
    const { proof, publicSignals } = await snarkjs().groth16.fullProve(w.input, this.cfg.zk.wasm, this.cfg.zk.zkey);
    const p = packProof(proof, publicSignals);
    return { p: { proof: p.proof.toString('base64'), pubs: p.pubs.map(String) }, changeNote: change, nullifierHash: p.pubs[1] };
  }
  async relayerInfo() { return fetch(this.cfg.relayer + '/info').then((x) => x.json()); }
  /// The fee (bps) the relayer needs for this request: at least its minimum, and enough to pay back the rent and fees the
  /// request costs it (a small amount pays a higher rate; the relayer refuses one that would need more than its maximum).
  async feeFor(body) {
    const r = await fetch(this.cfg.relayer + '/fee', { method: 'POST', headers: { 'content-type': 'application/json' }, body: j(body) }).then((x) => x.json());
    if (r.error) throw new Error(r.error.charAt(0).toUpperCase() + r.error.slice(1) + '.');
    return Number(r.feeBps);
  }
  async submit(req) {
    this.log('Relayer submits it. Your wallet never touches this transaction');
    const r = await fetch(this.cfg.relayer + '/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: j(req) }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    this._syncFresh = true; // the next shieldSync waits for a tree that includes this action
    return r;
  }
  /// After a spend lands: mark spent notes, place the change note at its tree index.
  async _afterSpend(spent, changeNote) {
    for (const n of spent) n.spent = true;
    if (changeNote) { delete changeNote.pending; for (let k = 0; k < 6 && changeNote.index === undefined; k++) { try { const st = await this.state(changeNote.pool, false); const i = st.leaves.findIndex((l) => String(l) === String(changeNote.commitment)); if (i >= 0) changeNote.index = i; else await new Promise((r) => setTimeout(r, 1000)); } catch { await new Promise((r) => setTimeout(r, 1000)); } } }
    this.store.save();
  }
  /// Pick one note covering `amount` (v1: no multi-note joins).
  pick(sym, amount) {
    const v = this.unit(sym, amount); const ns = this.notes(sym).filter((n) => BigInt(n.value) >= v).sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : 1));
    if (!ns.length) { const max = this.notes(sym).reduce((m, n) => (BigInt(n.value) > m ? BigInt(n.value) : m), 0n);
      throw new Error(max > 0n ? 'Each action spends from one deposit. Your largest single deposit is ' + this.fmt(sym, max) + ' ' + sym + '.' : 'No private balance in ' + sym + '.'); }
    return { note: ns[0], v };
  }
  async guardRecipient(addr) {
    let k; try { k = new PublicKey(addr); } catch { throw new PrivacyError('That is not a valid Solana address.'); }
    if (this.account && k.toBase58() === this.account) throw new PrivacyError('That is the wallet you deposited from. Sending there links the two. Use a fresh address.');
    const sigs = await this.conn.getSignaturesForAddress(k, { limit: 1 });
    if (sigs.length) throw new PrivacyError('That address has a history on-chain. A fresh, unused address keeps you private.');
  }
  deadline() { return Math.floor(Date.now() / 1000) + 1500; }

  // ---- actions
  async withdraw(sym, amount, to, { allowUsed = false } = {}) {
    if (!allowUsed) await this.guardRecipient(to);
    const { note, v } = this.pick(sym, amount); const info = await this.relayerInfo(); const mint = this.tok(sym).mint;
    const d = { recipient: to, feeRecipient: info.address, feeBps: info.minFeeBps, deadline: this.deadline() };
    d.feeBps = await this.feeFor({ kind: 'relay', mint, value: v, d });
    const { p, changeNote } = await this.prove(note, v, 'relay', d);
    const r = await this.submit({ kind: 'relay', mint, d, p });
    await this._afterSpend([note], changeNote);
    return { tx: r.txHash, received: v - (v * BigInt(d.feeBps)) / 10000n };
  }
  /// Direct pool, or two hops through a hub; picks the best quote (computed on this device from the bin arrays). Every pool
  /// a path needs is read once, all in parallel, then each path is simulated locally (same result as V.quoteLocal per hop,
  /// without re-reading a pool for every path: with dozens of pools over a remote RPC that took tens of seconds).
  /// -> { path: [{ pool, xForY, out, name, feePips (the pool's base fee), volatilityPips (its variable fee now) }], out, fee,
  /// lpFee, protocolFee }: lpFee and protocolFee (the fixed 0.2% of each hop's input) in atoms of the input token (a second
  /// hop's converted at the first hop's rate); `fee` = their sum per hop in each hop's own token, as before.
  async quoteRoute(symIn, symOut, amountIn) {
    const pools = this.cfg.binPools; const paths = [];
    const hopsFor = (a, b) => pools.filter((p) => (p.x === a && p.y === b) || (p.x === b && p.y === a)).map((p) => ({ pool: p.address, xForY: p.x === a, out: p.x === a ? p.y : p.x, name: this.tokLabel(p.x) + '–' + this.tokLabel(p.y) }));
    for (const h of hopsFor(symIn, symOut)) paths.push([h]);
    for (const h1 of pools.flatMap((p) => hopsFor(symIn, p.x === symIn ? p.y : p.x)).filter((h) => h.out !== symOut)) for (const h2 of hopsFor(h1.out, symOut)) paths.push([h1, h2]);
    const state = new Map(); for (const h of paths.flat()) { const k = h.pool + (h.xForY ? ':x' : ':y'); if (!state.has(k)) state.set(k, (async () => { const pool = new PublicKey(h.pool); const p = await this.V.binPool(pool); return { p, bins: await this.V.bins(pool, S.chunksForSwap(p, h.xForY, S.SWAP_ARRAYS)) }; })().catch(() => null)); }
    const loaded = new Map(await Promise.all([...state].map(async ([k, v]) => [k, await v])));
    let best = null; const now = Math.floor(Date.now() / 1000); amountIn = BigInt(amountIn);
    for (const path of paths) { let amt = amountIn, ok = true, fee = 0n, lpFee = 0n, protocolFee = 0n, rate = null; const hops = [];
      for (const h of path) { const s = loaded.get(h.pool + (h.xForY ? ':x' : ':y'));
        try { if (!s) throw new Error('pool unavailable'); const q = S.simulateSwap(s.p, s.bins, h.xForY, amt, now); const pr = S.protocolFeeOf(amt, s.p.protocolFeeBps === undefined ? S.PROTOCOL_FEE_BPS : s.p.protocolFeeBps);
          const toIn = (v) => (rate ? (v * rate[0]) / rate[1] : v); lpFee += toIn(q.lpFee); protocolFee += toIn(pr); if (!rate) rate = [amt, q.out > 0n ? q.out : 1n]; else rate = [rate[0] * amt, rate[1] * (q.out > 0n ? q.out : 1n)];
          const { ref, iref } = S.refsOf(s.p, now); const cur = Number(S.feeOf(s.p, S.accOf(ref, iref, s.p.activeId)));
          hops.push({ ...h, feePips: Number(s.p.baseFee), volatilityPips: Math.max(0, cur - Number(s.p.baseFee)) }); amt = q.out; fee += q.fee; } catch { ok = false; break; } }
      if (ok && amt > 0n && (!best || amt > best.out)) best = { path: hops, out: amt, fee, lpFee, protocolFee }; }
    return best;
  }
  async swap(symIn, symOut, amountIn, { slippageBps = 100 } = {}) {
    const { note, v } = this.pick(symIn, amountIn); const info = await this.relayerInfo();
    const feeBps = await this.feeFor({ kind: 'swap', mint: this.tok(symIn).mint, value: v, d: { tokenOut: this.tok(symOut).mint, recipient: null } });
    const net = v - (v * BigInt(feeBps)) / 10000n;
    const best = await this.quoteRoute(symIn, symOut, net); if (!best) throw new Error('No route with liquidity for that pair.');
    const outSec = newNote(); const refundKey = Keypair.generate(); // one-time; only needed to ragequit an unapproved output
    const outTok = this.tok(symOut);
    const outNote = { pool: outTok.pool, sym: symOut, nullifier: outSec.nullifier, secret: outSec.secret, precommitment: outSec.precommitment, refundKey: Buffer.from(refundKey.secretKey).toString('base64'), createdAt: Date.now() };
    this.store.data.notes.push(outNote); this.store.save();
    const routes = await this.V.prepareRoutes([{ amountIn: net, hops: best.path.map((h) => ({ pool: h.pool, xForY: h.xForY })) }]);
    const d = { tokenOut: outTok.mint, routes, minOut: best.out - (best.out * BigInt(slippageBps)) / 10000n, recipient: null, outPrecommitment: BigInt(outSec.precommitment), refundTo: refundKey.publicKey.toBase58(), feeRecipient: info.address, feeBps, deadline: this.deadline() };
    const { p, changeNote } = await this.prove(note, v, 'swap', d);
    const r = await this.submit({ kind: 'swap', mint: this.tok(symIn).mint, d, p });
    await this._afterSpend([note], changeNote); await this.refreshNotes();
    return { tx: r.txHash, out: BigInt(outNote.value || best.out), route: best.path.map((h) => h.name) };
  }
  // ---- pools (everything read from the chain; nothing estimated)
  poolCfg(addr) { const a = b58(addr); return this.cfg.binPools.find((p) => p.address === a); }
  /// One pool: parameters, active bin, current dynamic fee, reserves in the vaults (less the protocol's balance), lifetime
  /// fees, rewards, and the bins `span` either side of the active bin.
  async poolState(addr, span = 35) { const pk = new PublicKey(addr); const bp = await this.V.binPool(pk); if (!bp) throw new Error('This pool is not on chain.');
    const a = bp.activeId; const vault = async (k) => BigInt((await this.conn.getTokenAccountBalance(k)).value.amount);
    // bins and both vaults in one round trip (they only need the pool account); the fee is computed from it, not re-read
    const [m, v] = await Promise.all([this.V.bins(pk, [...new Set([chunkOf(a - span), chunkOf(a), chunkOf(a + span)])]), Promise.all([vault(bp.vaultX), vault(bp.vaultY)]).catch(() => [0n, 0n])]);
    return this._poolStateOf(addr, bp, m, v[0], v[1], span); }
  /// Many pools' states in a few requests (getMultipleAccounts: the pools, then every bin array and vault they need), the
  /// same objects poolState returns, in `addrs` order. A pool that isn't on chain gets an Error in its place.
  async poolStates(addrs, span = 35) { const keys = addrs.map((x) => new PublicKey(x)); const many = async (ks) => { const out = [];
      for (let i = 0; i < ks.length; i += 100) out.push(...(await this.conn.getMultipleAccountsInfo(ks.slice(i, i + 100), 'confirmed'))); return out; };
    const bps = (await many(keys)).map((a, i) => (a ? S.decodeBinPool(keys[i], a.data) : null));
    const need = []; const at = new Map(); const want = (k) => { const s = k.toBase58(); if (!at.has(s)) { at.set(s, need.length); need.push(k); } return at.get(s); };
    const plan = bps.map((bp, i) => { if (!bp) return null; const a = bp.activeId; const chunks = [...new Set([chunkOf(a - span), chunkOf(a), chunkOf(a + span)])];
      return { chunks: chunks.map((c) => want(this.V.binArrayPda(keys[i], c))), vx: want(bp.vaultX), vy: want(bp.vaultY) }; });
    const infos = await many(need); const amount = (j) => { const d = infos[j] && infos[j].data; return d && d.length >= 72 ? Buffer.from(d).readBigUInt64LE(64) : 0n; }; // SPL / Token-2022 account: amount at 64
    return Promise.all(bps.map(async (bp, i) => { if (!bp) return new Error('This pool is not on chain.'); const m = new Map();
      for (const j of plan[i].chunks) if (infos[j]) for (const b of S.decodeBinArray(infos[j].data).bins) m.set(b.id, b);
      return this._poolStateOf(addrs[i], bp, m, amount(plan[i].vx), amount(plan[i].vy), span).catch((e) => (e instanceof Error ? e : new Error(String(e)))); })); }
  async _poolStateOf(addr, bp, m, vx, vy, span) { const c = this.poolCfg(addr); const a = bp.activeId; const now = Math.floor(Date.now() / 1000);
    const { ref, iref } = S.refsOf(bp, now); const fee = Number(S.feeOf(bp, S.accOf(ref, iref, a))); const bins = {};
    for (let i = a - span; i <= a + span; i++) { const x = m.get(i); bins[i] = x ? { x: x.x, y: x.y, shares: x.shares, askX: x.askX || 0n, bidY: x.bidY || 0n } : { x: 0n, y: 0n, shares: 0n, askX: 0n, bidY: 0n }; }
    const rewards = bp.rewards.map((r, i) => (r.initialized ? { index: i, sym: this.symOf(r.mint) || null, mint: r.mint.toBase58(), live: Number(r.end) > now && r.rate > 0n, end: Number(r.end), ratePerSec: r.rate >> 64n } : null)).filter(Boolean);
    if (!this._fac) { try { await this._factory(); } catch { /* tier labels from the bin step */ } }
    return { address: b58(addr), x: c.x, y: c.y, binStep: bp.binStep, baseFee: bp.baseFee, fee, active: a, price: priceOf(bp.basePrice, bp.binStep, a), bp, bins,
      reserves: { x: vx - bp.protocolFeeX, y: vy - bp.protocolFeeY }, totalFees: { x: bp.totalFeeX, y: bp.totalFeeY }, protocolShare: 0, protocolFeeBps: bp.protocolFeeBps, tier: this._poolTier(bp), status: await this.poolStatus(addr, bp), rewards, seeded: bp.seeded }; }
  async poolInfo(pool) { const s = await this.poolState(pool.address, 30); return { active: s.active, fee: s.fee, price: s.price, bins: s.bins, seeded: s.seeded }; }
  /// Human price (Y per X) of bin `id`, and the bin nearest a human price.
  humanPrice(state, id) { const q = Number(priceOf(state.bp.basePrice, state.bp.binStep, id)) / 2 ** 128; return q * 10 ** (this.tok(state.x).decimals - this.tok(state.y).decimals); }
  binForPrice(state, human) { const p0 = this.humanPrice(state, state.active); return state.active + Math.round(Math.log(human / p0) / Math.log(1 + state.binStep / 1e4)); }

  // ---- transactions signed by the wallet (public actions). v0 with the deployment's lookup table when there is one.
  ataIx(payer, mint, owner, tp) { const ata = this.V.ata(mint, owner, tp); return new TransactionInstruction({ programId: S.ATA_PROGRAM, data: Buffer.from([1]),
    keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ata, isSigner: false, isWritable: true }, { pubkey: new PublicKey(owner), isSigner: false, isWritable: false }, { pubkey: new PublicKey(mint), isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: tp, isSigner: false, isWritable: false }] }); }
  async ataIxs(bp) { return [this.ataIx(this.pk, bp.mintX, this.pk, bp.tokenProgramX), this.ataIx(this.pk, bp.mintY, this.pk, bp.tokenProgramY)]; }
  /// Every lookup table of the deployment (one per 256 addresses), loaded once.
  async _luts() { if (this._lutAll !== undefined) return this._lutAll; const keys = [this.cfg.lookupTable, ...(this.cfg.lookupTables || [])].filter(Boolean); const out = [];
    for (const k of keys) { try { const t = (await this.conn.getAddressLookupTable(new PublicKey(k))).value; if (t) out.push(t); } catch { /* skip */ } } this._lutAll = out; return out; }
  async _lut() { const all = await this._luts(); return all[0] || null; }
  /// Sign every transaction in one wallet prompt where the wallet allows it, then send them in order, each confirmed.
  async _sendAll(groups, cu = 1_400_000) {
    if (!this.pk) throw new Error('Connect a wallet first.');
    const luts = await this._luts(); const { blockhash } = await this.conn.getLatestBlockhash();
    const txs = groups.filter((g) => g.length).map((ixs) => { const all = [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs];
      return new VersionedTransaction(new TransactionMessage({ payerKey: this.pk, recentBlockhash: blockhash, instructions: all }).compileToV0Message(luts)); });
    this.log(txs.length > 1 ? 'Confirm ' + txs.length + ' transactions in your wallet' : 'Confirm in your wallet');
    const signed = this.wallet.signAllTransactions && txs.length > 1 ? await this.wallet.signAllTransactions(txs) : await (async () => { const o = []; for (const t of txs) o.push(await this.wallet.signTransaction(t)); return o; })();
    const sigs = []; for (const t of signed) { this.log('Sending to ' + (this.cfg.chainName || 'Solana')); const sig = await this.conn.sendRawTransaction(t.serialize()); const r = await this.conn.confirmTransaction(sig, 'confirmed'); if (r.value.err) throw new Error('Transaction failed on-chain (' + JSON.stringify(r.value.err) + ').'); sigs.push(sig); }
    return sigs[sigs.length - 1]; }

  /// Serialized size of a v0 transaction (the limit is 1,232 bytes), with this deployment's lookup table.
  async _bytes(ixs, payer) { const luts = await this._luts(); try { const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: PublicKey.default.toBase58(), instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs] }).compileToV0Message(luts); return new VersionedTransaction(msg).serialize().length; } catch { return Infinity; } }
  /// The size of the transaction the relayer will build for a signed position action (same instructions, same order).
  async _signedBytes(kind, d, relayer) { const me = new PublicKey(relayer); const bp = await this.V.binPool(new PublicKey(d.binPool)); const ixs = [];
    if (d.recipient) { const outs = kind === 'reward' ? [[bp.rewards[Number(d.index)].mint, bp.rewards[Number(d.index)].tokenProgram]] : [[bp.mintX, bp.tokenProgramX], [bp.mintY, bp.tokenProgramY]]; for (const [m, tp] of outs) ixs.push(this.ataIx(me, m, new PublicKey(d.recipient), tp)); }
    const build = { remove: () => this.V.privateRemoveIx(me, d), claim: () => this.V.privateClaimFeesIx(me, d), reward: () => this.V.privateClaimRewardIx(me, d), orderWithdraw: () => this.V.privateWithdrawOrderIx(me, d), rebalance: () => this.V.privateRebalanceIx(me, d) }[kind];
    ixs.push(this.V.signedSigIx(kind, d.owner, Buffer.alloc(64), d), await build()); return this._bytes(ixs, me); }
  static MAX_TX = 1232;
  static PRIVATE_MAX_BINS = 15;

  // ---- positions and orders (kind: 'private' = one-time key under the entry's signer; 'public' = wallet authority)
  authOf(x) { return x.kind === 'public' ? new PublicKey(x.authority) : this.V.signerPda(); }
  async positionInfo(pos) { const r = await this.V.position(new PublicKey(pos.pool), new PublicKey(pos.owner), this.authOf(pos), pos.ids); const bp = await this.V.binPool(new PublicKey(pos.pool));
    const shares = pos.ids.map((id) => { const b = r.bins.find((x) => x.id === id); return b ? b.shares : 0n; });
    return { ...r, shares, active: bp.activeId, inRange: bp.activeId >= pos.lo && bp.activeId <= pos.hi, open: shares.some((x) => x > 0n) }; }
  async positionValue(pos) { const i = await this.positionInfo(pos); return { x: i.value.x, y: i.value.y, shares: i.shares, active: i.active }; }
  async orderInfo(o) { const r = await this.V.position(new PublicKey(o.pool), new PublicKey(o.owner), this.authOf(o), [o.binId]); return r.orders.find((x) => x.isAsk === !!o.isAsk) || null; }
  myPositions() { return this.store.data.positions.filter((p) => p.kind !== 'public' || p.authority === this.account); }
  myOrders() { return this.store.data.orders.filter((p) => p.kind !== 'public' || p.authority === this.account); }

  /// Amounts per bin for a shape over [lo, hi] around the active bin (the program's own side rule and remainder rule).
  plan(state, lo, hi, shape, ax, ay) { const ids = []; for (let i = lo; i <= hi; i++) ids.push(i);
    const w = shapeWeights(ids, state.active, shape);
    const xs = distribute(ax, w.weightsX), ys = distribute(ay, w.weightsY); const keep = ids.map((_, i) => xs[i] > 0n || ys[i] > 0n);
    return { ids: ids.filter((_, i) => keep[i]), xs: xs.filter((_, i) => keep[i]), ys: ys.filter((_, i) => keep[i]), weightsX: w.weightsX, weightsY: w.weightsY, allIds: ids }; }
  async minSharesFor(pk, ids, xs, ys, slippageBps, adjust) { const bp = await this.V.binPool(pk); const bins = await this.V.bins(pk, [...new Set(ids.map(chunkOf))]); const fee = await this.V.currentFee(pk);
    return ids.map((id, i) => { let b = bins.get(id) || EMPTY_BIN; if (adjust && adjust[id]) b = { ...b, x: b.x - adjust[id].x, y: b.y - adjust[id].y, shares: b.shares - adjust[id].s }; const sh = sharesForMint(bp, b, id, bp.activeId, xs[i], ys[i], fee); return (sh * BigInt(10000 - slippageBps)) / 10000n; }); }
  _savePos(pos) { this.store.data.positions.push(pos); this.store.save(); return pos; }

  /// Add liquidity. opts: { priv, lo, hi, shape, amountX, amountY } (human amounts). Private: one proof per token leg, a
  /// one-time key owns the position. Public: the wallet signs; bins are split over several transactions when needed.
  async addLiquidity(pool, o) {
    const addr = pool.address; const pk = new PublicKey(addr); const st = await this.poolState(addr, 1); const shape = o.shape === 'bidask' ? 'bidAsk' : o.shape || 'spot';
    const lo = o.lo !== undefined ? o.lo : st.active - o.range, hi = o.hi !== undefined ? o.hi : st.active + o.range; if (hi < lo) throw new Error('Pick a range.');
    const slip = o.slippageBps || 100;
    if (!o.priv) { if (!this.pk) throw new Error('Connect a wallet first.');
      const ax = o.amountX > 0 ? this.unit(pool.x, o.amountX) : 0n, ay = o.amountY > 0 ? this.unit(pool.y, o.amountY) : 0n;
      const pl = this.plan(st, lo, hi, shape, ax, ay); if (!pl.ids.length) throw new Error(this._sideHint(st, lo, hi, ax, ay));
      const owner = Keypair.generate().publicKey; const groups = []; const per = 16;
      for (let k = 0; k < pl.ids.length; k += per) { const ids = pl.ids.slice(k, k + per), xs = pl.xs.slice(k, k + per), ys = pl.ys.slice(k, k + per);
        const pre = await this.V.ensureBinAccountsIxs(this.pk, pk, ids, owner, this.pk); if (pre.length) groups.push(pre);
        groups.push([await this.V.mintIx(this.pk, pk, { owner, authority: this.pk, ids, amountsX: xs, amountsY: ys, minShares: await this.minSharesFor(pk, ids, xs, ys, slip), deadline: this.deadline() })]); }
      const tx = await this._sendAll(groups);
      return this._savePos({ id: 'q' + Date.now(), kind: 'public', pool: addr, x: pool.x, y: pool.y, owner: owner.toBase58(), authority: this.account, ids: pl.ids, lo, hi, shape, createdAt: Date.now(), tx }); }
    const info = await this.relayerInfo(); const spend = [];
    if (o.amountX > 0) { const { note, v } = this.pick(pool.x, o.amountX); spend.push({ note, v, sym: pool.x }); }
    if (o.amountY > 0) { const { note, v } = this.pick(pool.y, o.amountY); spend.push({ note, v, sym: pool.y }); }
    if (!spend.length) throw new Error('Enter an amount.');
    const owner = Keypair.generate(); const span = []; for (let i = lo; i <= hi; i++) span.push(i);
    if (span.length > Engine.PRIVATE_MAX_BINS) throw new Error('A private position covers up to ' + Engine.PRIVATE_MAX_BINS + ' bins: it has to fit one relayed transaction. Narrow the range.');
    const feeBps = await this.feeFor({ kind: 'add', legs: spend.map((s) => ({ mint: this.tok(s.sym).mint, value: s.v })), d: { binPool: addr, ids: span, owner: owner.publicKey.toBase58() } });
    let netX = 0n, netY = 0n; for (const s of spend) { const net = s.v - (s.v * BigInt(feeBps)) / 10000n; if (s.sym === pool.x) netX = net; else netY = net; }
    const pl = this.plan(st, lo, hi, shape, netX, netY); if (!pl.ids.length) throw new Error(this._sideHint(st, lo, hi, netX, netY));
    const minShares = await this.minSharesFor(pk, pl.ids, pl.xs, pl.ys, slip);
    const d = { binPool: addr, ids: pl.ids, amountsX: pl.xs, amountsY: pl.ys, minShares, owner: owner.publicKey.toBase58(), feeRecipient: info.address, feeBps, deadline: this.deadline() };
    if ((await this._bytes([await this.V.privateAddIx(new PublicKey(info.address), spend.map((x, i) => ({ mint: new PublicKey(this.tok(x.sym).mint), nullifierHash: BigInt(i + 1) })), d)], info.address)) > Engine.MAX_TX) throw new Error('This range does not fit one relayed transaction. Narrow it by a few bins.');
    const proofs = []; for (const s of spend) proofs.push(await this.prove(s.note, s.v, 'add', d));
    const r = await this.submit({ kind: 'add', d, legs: spend.map((s, i) => ({ mint: this.tok(s.sym).mint, p: proofs[i].p })) });
    for (let i = 0; i < spend.length; i++) await this._afterSpend([spend[i].note], proofs[i].changeNote);
    return this._savePos({ id: 'p' + Date.now(), kind: 'private', pool: addr, x: pool.x, y: pool.y, owner: owner.publicKey.toBase58(), key: Buffer.from(owner.secretKey).toString('base64'), ids: pl.ids, lo, hi, shape, createdAt: Date.now(), tx: r.txHash }); }
  _sideHint(st, lo, hi, ax, ay) { if (lo > st.active && ax === 0n) return 'This range sits above the price: only ' + st.x + ' goes in it.'; if (hi < st.active && ay === 0n) return 'This range sits below the price: only ' + st.y + ' goes in it.'; return 'Nothing to add in this range.'; }

  /// Zap: one token in, part swapped inside the pool, the rest added by the shape. opts: { priv, xIn, amount, lo, hi, shape }.
  async zap(pool, o) { const addr = pool.address; const pk = new PublicKey(addr); const st = await this.poolState(addr, 1); const shape = o.shape === 'bidask' ? 'bidAsk' : o.shape || 'spot';
    const ids = []; for (let i = o.lo; i <= o.hi; i++) ids.push(i); const w = shapeWeights(ids, st.active, shape); const sym = o.xIn ? pool.x : pool.y; const slip = o.slippageBps || 200;
    if (!o.priv) { if (!this.pk) throw new Error('Connect a wallet first.'); if (ids.length > 16) throw new Error('A public zap covers up to 16 bins per transaction. Narrow the range.');
      const amt = this.unit(sym, o.amount); const plan = await this.V.planZap(pk, { xIn: !!o.xIn, amountIn: amt, ids, ...w, slippageBps: slip });
      const owner = Keypair.generate().publicKey; const pre = await this.V.ensureBinAccountsIxs(this.pk, pk, ids, owner, this.pk); const bp = await this.V.binPool(pk);
      const ix = await this.V.swapAndAddIx(this.pk, pk, { owner, authority: this.pk, xIn: !!o.xIn, amountIn: amt, swapAmount: plan.swapAmount, minSwapOut: plan.minSwapOut, ids, ...w, minShares: plan.minShares, deadline: this.deadline() });
      const tx = await this._sendAll([pre, [...(await this.ataIxs(bp)), ix]]);
      return this._savePos({ id: 'q' + Date.now(), kind: 'public', pool: addr, x: pool.x, y: pool.y, owner: owner.toBase58(), authority: this.account, ids, lo: o.lo, hi: o.hi, shape, zap: true, createdAt: Date.now(), tx }); }
    if (ids.length > Engine.PRIVATE_MAX_BINS) throw new Error('A private zap covers up to ' + Engine.PRIVATE_MAX_BINS + ' bins: it has to fit one relayed transaction. Narrow the range.');
    const { note, v } = this.pick(sym, o.amount); const info = await this.relayerInfo(); const owner = Keypair.generate(); const mint = this.tok(sym).mint;
    const d = { binPool: addr, xIn: !!o.xIn, swapAmount: 0n, minSwapOut: 0n, ids, ...w, minShares: ids.map(() => 0n), owner: owner.publicKey.toBase58(), feeRecipient: info.address, feeBps: 0, deadline: this.deadline() };
    d.feeBps = await this.feeFor({ kind: 'zap', d, legs: [{ mint, value: v }] }); const net = v - (v * BigInt(d.feeBps)) / 10000n;
    const plan = await this.V.planZap(pk, { xIn: !!o.xIn, amountIn: net, ids, ...w, slippageBps: slip }); Object.assign(d, { swapAmount: plan.swapAmount, minSwapOut: plan.minSwapOut, minShares: plan.minShares });
    const pr = await this.prove(note, v, 'zap', d); const r = await this.submit({ kind: 'zap', d, legs: [{ mint, p: pr.p }] }); await this._afterSpend([note], pr.changeNote);
    return this._savePos({ id: 'p' + Date.now(), kind: 'private', pool: addr, x: pool.x, y: pool.y, owner: owner.publicKey.toBase58(), key: Buffer.from(owner.secretKey).toString('base64'), ids, lo: o.lo, hi: o.hi, shape, zap: true, createdAt: Date.now(), tx: r.txHash }); }
  async planZapPreview(pool, o) { const st = await this.poolState(pool.address, 1); const ids = []; for (let i = o.lo; i <= o.hi; i++) ids.push(i); const shape = o.shape === 'bidask' ? 'bidAsk' : o.shape || 'spot';
    const sym = o.xIn ? pool.x : pool.y; const p = await this.V.planZap(new PublicKey(pool.address), { xIn: !!o.xIn, amountIn: this.unit(sym, o.amount), ids, ...shapeWeights(ids, st.active, shape), slippageBps: 200 });
    return { swapIn: this.fmt(sym, p.swapAmount), swapOut: this.fmt(o.xIn ? pool.y : pool.x, p.swapOut), activeAfter: p.activeAfter, bins: p.amountsX.filter((x, i) => x > 0n || p.amountsY[i] > 0n).length, lpFee: p.lpFee, protocolFee: p.protocolFee }; } // fees: atoms of the token zapped in (its swapped part)

  // ---- notes paid out by a signed private action: the ones the chain did not create (a zero amount) are dropped
  _outNote(sym, key) { const s = newNote(); return { pool: this.tok(sym).pool, sym, nullifier: s.nullifier, secret: s.secret, precommitment: s.precommitment, refundKey: key, createdAt: Date.now() }; }
  async _settleOut(notes, tx) { let evs = []; try { evs = await this.V.events(tx); } catch {}
    for (const n of notes) { const e = evs.find((x) => x.name === 'Deposited' && String(x.precommitment) === n.precommitment); if (e) { n.index = Number(e.index); n.label = e.label.toString(); n.value = e.value.toString(); } else if (evs.length) n.dropped = true; }
    this.store.data.notes = this.store.data.notes.filter((n) => !n.dropped); this.store.save(); return notes.filter((n) => !n.dropped); }
  async _signed(kind, pos, d) { d.feeBps = await this.feeFor({ kind, d }); this.log('Signing with the position key on this device');
    const sig = nacl.sign.detached(signedDigest(kind, this.V.programs.entry, d), Buffer.from(pos.key, 'base64'));
    return this.submit({ kind, d, sig: Buffer.from(sig).toString('base64') }); }
  async _base(pos, extra) { const info = await this.relayerInfo(); return { owner: pos.owner, binPool: pos.pool, ...extra, recipient: extra.recipient || null, feeRecipient: info.address, feeBps: info.minFeeBps, nonce: await this.V.nonce(new PublicKey(pos.owner)), deadline: this.deadline() }; }
  _sum(notes) { const o = {}; for (const n of notes) o[n.sym] = (o[n.sym] || 0n) + BigInt(n.value || 0); return o; }

  /// Withdraw pct% of a position. Private: back to new notes, or to `to` (a public address). Public: to the wallet.
  async removeLiquidity(pos, pct, { to = null } = {}) {
    const i = await this.positionInfo(pos); const sh = i.shares.map((s) => (s * BigInt(pct)) / 100n); const keep = pos.ids.filter((_, k) => sh[k] > 0n); if (!keep.length) throw new Error('Nothing left to withdraw in this position.');
    const shares = sh.filter((s) => s > 0n); let r, out = [];
    if (pos.kind === 'public') { const bp = await this.V.binPool(new PublicKey(pos.pool)); const tx = await this._sendAll([[...(await this.ataIxs(bp)), await this.V.burnIx(this.pk, new PublicKey(pos.pool), { owner: new PublicKey(pos.owner), ids: keep, shares })]]); r = { txHash: tx }; }
    else { if (to) { try { new PublicKey(to); } catch { throw new PrivacyError('That is not a valid Solana address.'); } }
      const info = await this.relayerInfo(); const dummy = (ids) => ({ owner: pos.owner, binPool: pos.pool, ids, shares: ids.map(() => 1n), precommitX: 1n, precommitY: 1n, recipient: to, feeRecipient: info.address, feeBps: 5, nonce: 0n, deadline: this.deadline() });
      // one signed removal per group of bins that fits a relayed transaction (each with its own nonce)
      let groups = [keep.map((id, k) => [id, shares[k]])];
      for (let guard = 0; guard < 8; guard++) { let split = false; const next = [];
        for (const g of groups) { if (g.length > 1 && (await this._signedBytes('remove', dummy(g.map((x) => x[0])), info.address)) > Engine.MAX_TX) { next.push(g.slice(0, Math.ceil(g.length / 2)), g.slice(Math.ceil(g.length / 2))); split = true; } else next.push(g); }
        groups = next; if (!split) break; }
      for (const [k, g] of groups.entries()) { if (groups.length > 1) this.log('Removal ' + (k + 1) + ' of ' + groups.length);
        const nX = to ? null : this._outNote(pos.x, pos.key), nY = to ? null : this._outNote(pos.y, pos.key); if (!to) { this.store.data.notes.push(nX, nY); this.store.save(); }
        const d = await this._base(pos, { ids: g.map((x) => x[0]), shares: g.map((x) => x[1]), precommitX: nX ? BigInt(nX.precommitment) : 0n, precommitY: nY ? BigInt(nY.precommitment) : 0n, recipient: to });
        r = await this._signed('remove', pos, d); if (!to) out.push(...(await this._settleOut([nX, nY], r.txHash))); } }
    this.store.save(); const got = this._sum(out); return { tx: r.txHash, x: got[pos.x] || 0n, y: got[pos.y] || 0n, notes: out }; }
  async claimFees(pos, { to = null } = {}) {
    const i = await this.positionInfo(pos); if (i.fees.x === 0n && i.fees.y === 0n) throw new Error('This position has no fees to claim yet.');
    if (pos.kind === 'public') { const bp = await this.V.binPool(new PublicKey(pos.pool)); const tx = await this._sendAll([[...(await this.ataIxs(bp)), await this.V.claimFeesIx(this.pk, new PublicKey(pos.pool), { owner: new PublicKey(pos.owner), ids: pos.ids })]]); return { tx, x: i.fees.x, y: i.fees.y }; }
    const nX = to ? null : this._outNote(pos.x, pos.key), nY = to ? null : this._outNote(pos.y, pos.key); if (!to) { this.store.data.notes.push(nX, nY); this.store.save(); }
    const d = await this._base(pos, { ids: pos.ids, precommitX: nX ? BigInt(nX.precommitment) : 0n, precommitY: nY ? BigInt(nY.precommitment) : 0n, recipient: to });
    const r = await this._signed('claim', pos, d); const out = to ? [] : await this._settleOut([nX, nY], r.txHash); const g = this._sum(out);
    return { tx: r.txHash, x: to ? i.fees.x : g[pos.x] || 0n, y: to ? i.fees.y : g[pos.y] || 0n }; }
  async claimReward(pos, index, { to = null } = {}) {
    const i = await this.positionInfo(pos); if (!(i.rewards[index] > 0n)) throw new Error('This position has no rewards to claim yet.');
    const bp = await this.V.binPool(new PublicKey(pos.pool)); const rw = bp.rewards[index]; const sym = this.symOf(rw.mint);
    if (pos.kind === 'public') { const tx = await this._sendAll([[this.ataIx(this.pk, rw.mint, this.pk, rw.tokenProgram), await this.V.claimRewardIx(this.pk, new PublicKey(pos.pool), { owner: new PublicKey(pos.owner), index, ids: pos.ids })]]); return { tx, amount: i.rewards[index], sym }; }
    if (!sym && !to) throw new Error('This reward token has no private pool: claim it to an address instead.');
    const n = to ? null : this._outNote(sym, pos.key); if (n) { this.store.data.notes.push(n); this.store.save(); }
    const d = await this._base(pos, { index, ids: pos.ids, precommit: n ? BigInt(n.precommitment) : 0n, recipient: to });
    const r = await this._signed('reward', pos, d); const out = n ? await this._settleOut([n], r.txHash) : []; return { tx: r.txHash, amount: out[0] ? BigInt(out[0].value) : i.rewards[index], sym }; }
  /// Move a position to a new range / shape in one instruction (burn and re-add; leftovers return to notes or the wallet).
  async rebalance(pos, { lo, hi, shape }) { shape = shape === 'bidask' ? 'bidAsk' : shape || 'spot';
    const pk = new PublicKey(pos.pool); const i = await this.positionInfo(pos); const burnIds = pos.ids.filter((_, k) => i.shares[k] > 0n), burnShares = i.shares.filter((s) => s > 0n); if (!burnIds.length) throw new Error('This position is empty.');
    const ids = []; for (let k = lo; k <= hi; k++) ids.push(k); const st = await this.poolState(pos.pool, 1); const w = shapeWeights(ids, st.active, shape);
    const lim = await this.rebalanceLimit(pos); if (ids.length > lim) throw new Error('The old and new bins travel in one transaction: this position can move to at most ' + lim + ' bins at once.');
    const bins = await this.V.bins(pk, [...new Set([...burnIds, ...ids].map(chunkOf))]); let tx = 0n, ty = 0n; const adj = {};
    burnIds.forEach((id, k) => { const v = this.V.valueOf(bins.get(id), burnShares[k]); tx += v.x; ty += v.y; adj[id] = { x: v.x, y: v.y, s: burnShares[k] }; });
    const mk = async (feeBps) => { const fx = (tx * BigInt(feeBps)) / 10000n, fy = (ty * BigInt(feeBps)) / 10000n; const sw = sideWeights(ids, w.weightsX, w.weightsY, st.active);
      const ax = distribute(tx - fx, sw.weightsX), ay = distribute(ty - fy, sw.weightsY); return this.minSharesFor(pk, ids, ax, ay, 300, adj); };
    if (pos.kind === 'public') { const bp = await this.V.binPool(pk); const pre = await this.V.ensureBinAccountsIxs(this.pk, pk, ids, new PublicKey(pos.owner), this.pk);
      const ix = await this.V.rebalanceIx(this.pk, pk, { owner: new PublicKey(pos.owner), burnIds, burnShares, ids, ...w, minShares: await mk(0), deadline: this.deadline() });
      const t = await this._sendAll([pre, [...(await this.ataIxs(bp)), ix]]); Object.assign(pos, { ids, lo, hi, shape }); this.store.save(); return { tx: t }; }
    const nX = this._outNote(pos.x, pos.key), nY = this._outNote(pos.y, pos.key); this.store.data.notes.push(nX, nY); this.store.save();
    const d = await this._base(pos, { burnIds, burnShares, ids, ...w, minShares: ids.map(() => 1n), precommitX: BigInt(nX.precommitment), precommitY: BigInt(nY.precommitment) });
    d.feeBps = await this.feeFor({ kind: 'rebalance', d }); d.minShares = await mk(d.feeBps); this.log('Signing with the position key on this device');
    const sig = nacl.sign.detached(signedDigest('rebalance', this.V.programs.entry, d), Buffer.from(pos.key, 'base64'));
    const r = await this.submit({ kind: 'rebalance', d, sig: Buffer.from(sig).toString('base64') }); await this._settleOut([nX, nY], r.txHash);
    Object.assign(pos, { ids, lo, hi, shape }); this.store.save(); return { tx: r.txHash }; }

  /// The most new bins a rebalance of `pos` can take in one transaction (old bins, new bins and their minimums all travel together).
  async rebalanceLimit(pos) { const i = await this.positionInfo(pos); const burnIds = pos.ids.filter((_, k) => i.shares[k] > 0n); if (!burnIds.length) return 0;
    const pk = new PublicKey(pos.pool); const info = pos.kind === 'public' ? null : await this.relayerInfo(); const a = i.active; const cap = pos.kind === 'public' ? 41 : Engine.PRIVATE_MAX_BINS;
    const fits = async (m) => { const ids = []; const h = Math.floor((m - 1) / 2); for (let k = a - h; k < a - h + m; k++) ids.push(k); const w = { weightsX: ids.map(() => 10000), weightsY: ids.map(() => 10000) };
      if (pos.kind === 'public') { const ix = await this.V.rebalanceIx(this.pk || new PublicKey(pos.authority), pk, { owner: new PublicKey(pos.owner), burnIds, burnShares: burnIds.map(() => 1n), ids, ...w, minShares: ids.map(() => 1n), deadline: this.deadline() }); const bp = await this.V.binPool(pk); return (await this._bytes([...(await this.ataIxs(bp)), ix], this.pk || pos.authority)) <= Engine.MAX_TX; }
      const d = { owner: pos.owner, binPool: pos.pool, burnIds, burnShares: burnIds.map(() => 1n), ids, ...w, minShares: ids.map(() => 1n), precommitX: 1n, precommitY: 1n, recipient: null, feeRecipient: info.address, feeBps: 5, nonce: 0n, deadline: this.deadline() };
      return (await this._signedBytes('rebalance', d, info.address)) <= Engine.MAX_TX; };
    let lo = 0, hi = cap; while (lo < hi) { const m = Math.ceil((lo + hi) / 2); if (await fits(m)) lo = m; else hi = m - 1; } return lo; }

  /// Limit orders. Ask = sell X at a bin above the price; bid = buy X with Y at a bin below it.
  async placeOrder(pool, { priv, isAsk, binId, amount }) { const addr = pool.address; const pk = new PublicKey(addr); const sym = isAsk ? pool.x : pool.y; const st = await this.poolState(addr, 1);
    if (isAsk && binId <= st.active) throw new Error('A sell order sits above the current price. Raise the price.'); if (!isAsk && binId >= st.active) throw new Error('A buy order sits below the current price. Lower the price.');
    const base = { pool: addr, x: pool.x, y: pool.y, binId, isAsk: !!isAsk, sym, createdAt: Date.now() };
    if (!priv) { const owner = Keypair.generate().publicKey; const pre = await this.V.ensureBinAccountsIxs(this.pk, pk, [binId], owner, this.pk);
      const tx = await this._sendAll([[...pre, await this.V.placeOrderIx(this.pk, pk, { owner, authority: this.pk, id: binId, isAsk: !!isAsk, amount: this.unit(sym, amount), deadline: this.deadline() })]]);
      const o = { id: 'o' + Date.now(), kind: 'public', owner: owner.toBase58(), authority: this.account, amount: String(this.unit(sym, amount)), ...base, tx }; this.store.data.orders.push(o); this.store.save(); return o; }
    const { note, v } = this.pick(sym, amount); const info = await this.relayerInfo(); const owner = Keypair.generate(); const mint = this.tok(sym).mint;
    const d = { binPool: addr, id: binId, isAsk: !!isAsk, owner: owner.publicKey.toBase58(), feeRecipient: info.address, feeBps: 0, deadline: this.deadline() };
    d.feeBps = await this.feeFor({ kind: 'order', d, legs: [{ mint, value: v }] });
    const pr = await this.prove(note, v, 'order', d); const r = await this.submit({ kind: 'order', d, legs: [{ mint, p: pr.p }] }); await this._afterSpend([note], pr.changeNote);
    const o = { id: 'o' + Date.now(), kind: 'private', owner: owner.publicKey.toBase58(), key: Buffer.from(owner.secretKey).toString('base64'), amount: String(v - (v * BigInt(d.feeBps)) / 10000n), ...base, tx: r.txHash };
    this.store.data.orders.push(o); this.store.save(); return o; }
  async withdrawOrder(o, { to = null } = {}) { const cur = await this.orderInfo(o); if (!cur || cur.shares === 0n) throw new Error('Nothing left in this order.');
    let r, out = [];
    if (o.kind === 'public') { const bp = await this.V.binPool(new PublicKey(o.pool)); const tx = await this._sendAll([[...(await this.ataIxs(bp)), await this.V.withdrawOrderIx(this.pk, new PublicKey(o.pool), { owner: new PublicKey(o.owner), id: o.binId, isAsk: o.isAsk, shares: cur.shares })]]); r = { txHash: tx }; }
    else { const nX = to ? null : this._outNote(o.x, o.key), nY = to ? null : this._outNote(o.y, o.key); if (!to) { this.store.data.notes.push(nX, nY); this.store.save(); }
      const d = await this._base(o, { id: o.binId, isAsk: o.isAsk, shares: cur.shares, precommitX: nX ? BigInt(nX.precommitment) : 0n, precommitY: nY ? BigInt(nY.precommitment) : 0n, recipient: to });
      r = await this._signed('orderWithdraw', o, d); if (!to) out = await this._settleOut([nX, nY], r.txHash); }
    o.closed = Date.now(); this.store.save(); const g = this._sum(out);
    return { tx: r.txHash, x: o.kind === 'public' ? (o.isAsk ? cur.unfilledX : cur.filledX) : g[o.x] || 0n, y: o.kind === 'public' ? (o.isAsk ? cur.filledY : cur.unfilledY) : g[o.y] || 0n, filled: cur.filled }; }
  async swapPublic(symIn, symOut, amountIn, { slippageBps = 100 } = {}) { if (!this.pk) throw new Error('Connect a wallet first.'); const v = this.unit(symIn, amountIn);
    const best = await this.quoteRoute(symIn, symOut, v); if (!best) throw new Error('No route with liquidity for that pair.');
    const routes = await this.V.prepareRoutes([{ amountIn: v, hops: best.path.map((h) => ({ pool: h.pool, xForY: h.xForY })) }]); const tin = new PublicKey(this.tok(symIn).mint), tout = new PublicKey(this.tok(symOut).mint);
    const ix = await this.V.swapRouteIx(this.pk, tin, tout, routes, best.out - (best.out * BigInt(slippageBps)) / 10000n, this.deadline());
    const tx = await this._sendAll([[this.ataIx(this.pk, tout, this.pk, await this.V.tokenProgram(tout)), ix]]); return { tx, out: best.out, route: best.path.map((h) => h.name) }; }
  // ---- chain history (Devnet / Local): every figure below is read from the chain, nothing estimated
  /// The pool's transactions, newest first, from getSignaturesForAddress (paged, cached, incremental), decoded for its
  /// Swapped events (every swap through the pool, whoever routed it: wallets, the relayer, batch settlements) and its
  /// PoolCreated event. Covers at least `secs` back; `complete` when the pool's whole history was read.
  async poolActivity(addr, secs = 86400) { const pk = new PublicKey(addr); const key = pk.toBase58(); this._act = this._act || {};
    // the relayer's index of every pool's trades (one request for all pools), when it has this pool and is current
    // (its totals per window, `agg`, and its latest trades; poolStatsChain uses the totals when they cover the window)
    const R = await this._relayerActivity(); const r = R && R.pools[key];
    if (r && Math.floor(Date.now() / 1000) - R.at < 120) { const A = { swaps: r.recent.map(([t, x, i, o, f, pf, id, sig]) => ({ sig, t, xForY: !!x, amountIn: BigInt(i), amountOut: BigInt(o), fee: BigInt(f), protocolFee: BigInt(pf), activeId: id })),
      agg: r.agg, seen: new Set(), newest: r.newest, created: r.created, complete: r.complete, oldestT: r.oldestT ?? Infinity, relayer: true }; this._act[key] = A; return A; }
    const A = (this._act[key] && !this._act[key].relayer && this._act[key]) || (this._act[key] = { swaps: [], seen: new Set(), newest: null, created: null, complete: false, oldestT: Infinity });
    const now = Math.floor(Date.now() / 1000); const fresh = []; let before;
    for (let page = 0; page < 8; page++) { const sigs = await this.conn.getSignaturesForAddress(pk, { limit: 1000, before }, 'confirmed'); if (!sigs.length) { if (!A.newest) A.complete = true; break; }
      let stop = false; for (const s of sigs) { if (s.signature === A.newest) { stop = true; break; } fresh.push(s); }
      before = sigs[sigs.length - 1].signature; const oldT = sigs[sigs.length - 1].blockTime || now;
      if (stop) break; if (sigs.length < 1000) { A.complete = true; break; } if (oldT < now - secs && A.newest === null) break; }
    const ok = fresh.filter((s) => !s.err && !A.seen.has(s.signature));
    for (let i = 0; i < ok.length; i += 50) { const chunk = ok.slice(i, i + 50); const txs = await this.conn.getTransactions(chunk.map((s) => s.signature), { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      txs.forEach((t, k) => { const sig = chunk[k].signature; A.seen.add(sig); if (!t) return; const bt = t.blockTime || chunk[k].blockTime || now;
        for (const e of S.logEvents(t.meta && t.meta.logMessages)) { if (e.program !== this.V.programs.bin.toBase58()) continue; // only the bin program's own events: any program can log a look-alike
          if (e.name === 'Swapped' && e.pool.toBase58() === key) A.swaps.push({ sig, t: bt, xForY: e.xForY, amountIn: e.amountIn, amountOut: e.amountOut, fee: e.fee, protocolFee: e.protocolFee, activeId: e.activeId });
          if (e.name === 'PoolCreated' && e.pool.toBase58() === key) A.created = bt; } }); }
    if (fresh.length) A.newest = fresh[0].signature; for (const s of fresh) if (s.blockTime && s.blockTime < A.oldestT) A.oldestT = s.blockTime;
    A.swaps.sort((x, y) => x.t - y.t); return A; }
  /// The relayer's trade index for every pool (GET /activity: one request, fixed windows, so it can't tell which pool is
  /// looked at), cached 15 s; null when there is no relayer index (each pool's history is then read from the chain).
  async _relayerActivity() { if (!this.cfg.relayer) return null; const c = this._ra;
    if (c && c.v !== undefined && Date.now() - c.at < 15_000) return c.v; if (c && c.p) return c.p;
    const p = (async () => { try { const r = await fetch(this.cfg.relayer + '/activity'); if (!r.ok) return null; const j = await r.json(); return j && j.pools && j.at ? j : null; } catch { return null; } })();
    this._ra = { p }; const v = await p; this._ra = { v, at: Date.now() }; return v; }
  /// Candles for every pool at `res` seconds from the relayer's index (bin ids: price them with humanPrice), or null.
  async poolCandles(res) { if (!this.cfg.relayer) return null; try { const r = await fetch(this.cfg.relayer + '/candles?res=' + res); if (!r.ok) return null; const j = await r.json(); return j && j.pools ? j : null; } catch { return null; } }
  /// Dollars per token: the live market price; a token without one is valued through a pool against a priced token.
  usdMap(states = []) { const u = {}; for (const s of Object.keys(this.tokens)) { const m = this.market.usd(s); if (m) u[s] = m; }
    for (let pass = 0; pass < 2; pass++) for (const st of states) { if (!st) continue; const px = this.humanPrice(st, st.active); if (u[st.y] && !u[st.x]) u[st.x] = px * u[st.y]; if (u[st.x] && !u[st.y]) u[st.y] = u[st.x] / px; } return u; }
  /// A pool's figures over the last `secs`, from the chain (`st` = poolState(addr, 10), `U` = usdMap): volume, fees, LP fees,
  /// APR, fees / liquidity, liquidity, depth near the price, Score, the price path, age. Dollar figures need market prices;
  /// they are null without them.
  async poolStatsChain(addr, secs, st, U) { const A = await this.poolActivity(addr, Math.max(secs, 86400)); const now = Math.floor(Date.now() / 1000); const t0 = now - secs;
    const w = A.swaps.filter((s) => s.t > t0); const c = this.poolCfg(addr); const ux = U[c.x], uy = U[c.y]; const X = (a) => this.fmt(c.x, a), Y = (a) => this.fmt(c.y, a);
    let vx = 0n, vy = 0n, fx = 0n, fy = 0n, px = 0n, py = 0n; const g = A.agg && A.agg[secs]; // the relayer's totals (its trade list here is only the latest)
    if (g) { vx = BigInt(g.vx); vy = BigInt(g.vy); fx = BigInt(g.fx); fy = BigInt(g.fy); px = BigInt(g.px); py = BigInt(g.py); }
    else for (const s of w) { if (s.xForY) { vx += s.amountIn; fx += s.fee; px += s.protocolFee; } else { vy += s.amountIn; fy += s.fee; py += s.protocolFee; } }
    const priced = ux != null && uy != null; const usd = (a, b) => (priced ? X(a) * ux + Y(b) * uy : null);
    const tvl = usd(st.reserves.x, st.reserves.y); const fees = usd(fx, fy), lp = usd(fx - px, fy - py);
    let near = 0, all = 0; if (priced) for (const [id, b] of Object.entries(st.bins)) { const v = X(b.x) * ux + Y(b.y) * uy; all += v; if (Math.abs(+id - st.active) <= 10) near += v; }
    const before = A.swaps.filter((s) => s.t <= t0).pop(); const startId = g && g.startId != null ? g.startId : before ? before.activeId : w.length ? w[0].activeId : st.active; const price = this.humanPrice(st, st.active), p0 = this.humanPrice(st, startId);
    const apr = tvl > 0 ? (lp / tvl) * (31_536_000 / secs) * 100 : null; const depth = all > 0 ? near / all : null;
    return { chain: true, price, change: p0 > 0 ? (price / p0 - 1) * 100 : null, active: st.active, fee: st.fee, volumeUsd: usd(vx, vy), feesUsd: fees, lpFeesUsd: lp, tvlUsd: tvl, swaps: g ? g.n : w.length, raw: { vx, vy, fx, fy, px, py },
      aprPct: apr, feeTvlPct: tvl > 0 ? (fees / tvl) * 100 : null, depth, score: apr != null && depth != null ? apr * depth : null, ageSec: A.created ? now - A.created : A.complete && A.oldestT < Infinity ? now - A.oldestT : null,
      spark: w.length ? [p0, ...w.map((s) => this.humanPrice(st, s.activeId))] : [], sparkT: w.length ? [t0, ...w.map((s) => s.t)] : [], start: p0 }; }
  /// Recent swaps across the deployment's pools (from the cache poolActivity filled), newest first.
  recentChain(n = 40) { const out = []; for (const [addr, A] of Object.entries(this._act || {})) { const c = this.poolCfg(addr); if (!c) continue; for (const s of A.swaps) out.push({ ...s, pool: addr, x: c.x, y: c.y }); } return out.sort((a, b) => b.t - a.t).slice(0, n); }
  async exportEncrypted(pass) { return encryptBackup(this.store.export(), pass); }
  async importEncrypted(text, pass) { const plain = await decryptBackup(text, pass); const n = this.store.import(plain); let b = null; try { b = JSON.parse(plain); } catch { /* checked by import */ }
    // the backup's outbox (notes planned before it was made, possibly known nowhere else) joins this one before the rescan
    try { const s = this.store.data.shield; if (b && b.shield && b.shield.seed && b.shield.seed === s.seed) { const ob = (s.outbox ||= []); for (const o of b.shield.outbox || []) if (o && o.c && !ob.some((x) => x.c === o.c)) ob.push(o); this.store.save(); } } catch { /* restored without it */ }
    try { this.shieldInit(); await this.shieldSync(); } catch { /* rescanned on the next refresh */ }
    try { if (!this.store.data.backedUpAt && b && b.shield && b.shield.seed && b.shield.seed === this.store.data.shield.seed) this.markBackedUp(); } catch { /* restored, just not marked */ }
    return n; } // a file that restores this seed is a backup of it
  async ragequit(note) { if (!this.pk) throw new Error('Connect the wallet you deposited from.');
    const sig = await this._send([await this.V.ragequitIx(this.pk, new PublicKey(this.tok(note.sym).mint), { value: BigInt(note.value), label: BigInt(note.label), nullifier: BigInt(note.nullifier), secret: BigInt(note.secret) })], 200_000); note.spent = true; this.store.save(); return sig; }
}

// ------------------------------------------------------------- Phase 2: every private action spends shielded notes
installShield(Engine, PrivacyError);
installSealed(Engine);
installPools(Engine);
{ const P = Engine.prototype;
  /// The Phase 1 paths stay for what this device already holds: one-time-key positions and orders, and legacy notes (which
  /// move into the shielded pool with `migrate`). New private actions all go through the shielded pool.
  const legacy = {}; for (const k of ['deposit', 'withdraw', 'swap', 'addLiquidity', 'zap', 'removeLiquidity', 'claimFees', 'claimReward', 'rebalance', 'rebalanceLimit', 'placeOrder', 'withdrawOrder', 'orderInfo', 'positionInfo', 'myPositions', 'myOrders', 'refreshNotes', 'privateBalance']) legacy[k] = P[k];
  P.legacy = legacy;
  P.deposit = function (sym, amount) { return this.shieldDeposit(sym, amount); };
  /// Send privately: to a Veyl address (stays in the shielded pool) or to a Solana address (leaves it).
  P.withdraw = function (sym, amount, to, o) { return String(to).startsWith('veyl:') ? this.send(sym, amount, to) : this.shieldWithdraw(sym, amount, to, o); };
  P.swap = function (a, b, v, o) { return this.shieldSwap(a, b, v, o); };
  P.addLiquidity = function (pool, o) { return o.priv ? this.shieldAdd(pool, o) : legacy.addLiquidity.call(this, pool, o); };
  P.zap = function (pool, o) { return o.priv ? this.shieldZap(pool, o) : legacy.zap.call(this, pool, o); };
  P.removeLiquidity = function (pos, pct, o) { return pos.kind === 'shielded' ? this.shieldRemove(pos, pct) : legacy.removeLiquidity.call(this, pos, pct, o); };
  P.claimFees = function (pos, o) { return pos.kind === 'shielded' ? this.shieldClaim(pos) : legacy.claimFees.call(this, pos, o); };
  P.claimReward = function (pos, i, o) { if (pos.kind === 'shielded') throw new Error('Shielded positions do not earn farm rewards yet.'); return legacy.claimReward.call(this, pos, i, o); };
  P.rebalance = function (pos, o) { return pos.kind === 'shielded' ? this.shieldRebalance(pos, o) : legacy.rebalance.call(this, pos, o); };
  P.rebalanceLimit = async function (pos) { return pos.kind === 'shielded' ? Z.K : legacy.rebalanceLimit.call(this, pos); };
  P.placeOrder = function (pool, o) { return o.priv ? this.shieldPlaceOrder(pool, o) : legacy.placeOrder.call(this, pool, o); };
  P.withdrawOrder = function (o, opt) { return o.kind === 'shielded' ? this.shieldWithdrawOrder(o) : legacy.withdrawOrder.call(this, o, opt); };
  P.orderInfo = function (o) { return o.kind === 'shielded' ? this.shieldOrderInfo(o) : legacy.orderInfo.call(this, o); };
  P.positionInfo = function (pos) { return pos.kind === 'shielded' ? this.shieldPositionInfo(pos) : legacy.positionInfo.call(this, pos); };
  P.myPositions = function () { return [...this.shieldPositions(), ...legacy.myPositions.call(this)]; };
  P.myOrders = function () { if (!this.zw) this.shieldInit(); return [...(this.store.data.shield.orders || []), ...legacy.myOrders.call(this)]; };
  P.refreshNotes = async function () { try { await legacy.refreshNotes.call(this); } catch { /* legacy pools unreachable: the shielded pool still loads */ } try { await this.shieldSync(); this.shieldError = null; } catch (e) { this.shieldError = e.message; } };
  P.privateBalance = function (sym) { return this.shieldBalance(sym); };
  /// Phase 1 notes still on this device (they can move into the shielded pool, or be ragequit).
  P.legacyNotes = function () { return this.store.data.notes.filter((n) => !n.spent && n.index !== undefined && !n.migrated); };
}

// ------------------------------------------------------------- safety rails: a backup before the first deposit, linkability hints
/// Until it is backed up, the seed (the whole private balance) lives only in this browser. Before the first deposit the UI
/// asks for one of two things, kept in this account's store and tied to its seed: a downloaded backup (the UI calls
/// markBackedUp() once it has handed the exportEncrypted() file to the browser), or the explicit "I understand"
/// (ackNoBackup()). Deposits refuse with BackupRequiredError (code 'BACKUP_REQUIRED') while neither exists, on every real
/// network; config `requireBackup: false` or `engine.requireBackup = false` turns that off (scripted tests). The Sandbox
/// (play money) never asks.
class BackupRequiredError extends Error { constructor() { super('Back up this account first, or confirm that you understand: without a backup, losing this browser loses the money.'); this.code = 'BACKUP_REQUIRED'; } }
const CROWD_MIN = 50, LINK_SOON = 3_600_000, LINK_RECENT = 7 * 86_400_000, DEP_LOG = 50; // crowd as on the Privacy page; "soon" = 1 h; amounts matched over 7 days
const agoText = (ms) => { const m = Math.max(1, Math.round(ms / 60_000)); return m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };
const NETWORK_TIP = { id: 'network', text: 'The relayer sees your IP address when it sends for you. A VPN or Tor keeps that private too.' };
{ const P = Engine.prototype;
  const seedTag = (d) => String((d.shield && d.shield.seed) || '').slice(-12);
  const isDemo = (e) => !!(e.sandbox || e.cfg.sandbox);
  P.backupAcked = function () { const a = this.store.data.noBackupAck; return !!a && a.seed === seedTag(this.store.data); };
  /// True while the UI should show the backup step before a deposit: real money, no backup made, no "I understand" given.
  P.backupStepNeeded = function () { if (!this.zw) this.shieldInit(); return !isDemo(this) && !this.store.data.backedUpAt && !this.backupAcked(); };
  /// Whether a deposit refuses right now (the step is open and enforcement is on).
  P.backupEnforced = function () { const on = this.requireBackup ?? this.cfg.requireBackup ?? true; return on !== false && this.backupStepNeeded(); };
  /// { required, done, backedUpAt, ackAt, stepNeeded, enforced }: required = this network asks (not the Sandbox); done = a
  /// backup was made or the risk acknowledged; stepNeeded = required && !done; enforced = a deposit refuses now.
  P.backupState = function () { const d = this.store.data; const stepNeeded = this.backupStepNeeded();
    return { required: !isDemo(this), done: !isDemo(this) && !stepNeeded, backedUpAt: d.backedUpAt || null, ackAt: this.backupAcked() ? d.noBackupAck.at : null, stepNeeded, enforced: this.backupEnforced() }; };
  /// "I understand: without a backup, losing this browser loses the money." Returns the time stored. A backup can still be made later.
  P.ackNoBackup = function () { const d = this.store.data; if (!this.zw) this.shieldInit(); d.noBackupAck = { at: Date.now(), seed: seedTag(d) }; this.store.save(); return d.noBackupAck.at; };
  /// Call once the encrypted backup file (exportEncrypted) has been handed to the browser to save. Returns the time stored.
  P.markBackedUp = function () { this.store.data.backedUpAt = Date.now(); this.store.save(); return this.store.data.backedUpAt; };
  /// Refuses (BackupRequiredError) while the backup step is open and enforced; the deposit paths call it first.
  P.assertBackup = function () { if (this.backupEnforced()) throw new BackupRequiredError(); };
  const logDeposit = (e, sym, amount, r) => { const d = e.store.data; const log = (d.depLog ||= []); let v; try { v = r && r.value != null ? BigInt(r.value) : e.unit(sym, amount); } catch { return; }
    log.unshift({ sym, amount: String(v), at: Date.now(), tx: r && r.tx ? String(r.tx) : null }); log.length = Math.min(log.length, DEP_LOG); e.store.save(); };
  const shieldDep = P.shieldDeposit; P.shieldDeposit = async function (sym, amount) { this.assertBackup(); const r = await shieldDep.call(this, sym, amount); logDeposit(this, sym, amount, r); return r; };
  // the Sandbox has its own shieldDeposit (never asks for a backup): its deposits are logged here for linkRisks
  const dep = P.deposit; P.deposit = async function (sym, amount) { const r = await dep.call(this, sym, amount); if (isDemo(this)) logDeposit(this, sym, amount, r); return r; };
  /// This account's deposits of `sym`, newest first, within `within` ms: [{ sym, amount (atoms, string), at, tx }].
  P.recentDeposits = function (sym, within = LINK_RECENT) { const d = this.store.data, now = Date.now(); const all = [...(d.depLog || [])];
    for (const p of (d.shield && d.shield.pending) || []) if (p.at && !all.some((x) => x.tx && x.tx === String(p.tx))) all.push({ sym: p.sym, amount: String(p.amount), at: p.at, tx: p.tx ? String(p.tx) : null });
    return all.filter((x) => x.sym === sym && now - x.at < within).sort((a, b) => b.at - a.at); };
  /// The crowd a withdrawal blends into, from the last shielded sync: { token: approved deposits of that token into the
  /// shielded pool (null when unknown), total: notes in the shielded tree (the Privacy page's number), min: CROWD_MIN }.
  P.crowdSize = function (sym) { const st = this.shieldState; const total = st && st.leaves ? st.leaves.length : null; let token = null;
    try { if (sym && st && st.deposits) token = Number(st.deposits[this.tok(sym).mint] || 0); } catch { /* unknown token */ } return { token, total, min: CROWD_MIN }; };
  /// Hints (never a refusal) before private money leaves for a Solana address: what an onlooker could use to match the
  /// withdrawal to this account's deposit. A send to a Veyl address keeps the amount and both parties hidden: only the tip.
  /// Returns { warnings: [{ id: 'amount' | 'timing' | 'crowd', text }], tip: { id: 'network', text }, crowd: crowdSize(sym) }.
  /// The hard refusals (guardRecipient: own wallet, address with history) are unchanged.
  P.linkRisks = function (sym, amount, to) { const crowd = this.crowdSize(sym); const out = [];
    if (String(to || '').startsWith('veyl:')) return { warnings: out, tip: NETWORK_TIP, crowd };
    let v = 0n; try { v = this.unit(sym, amount); } catch { /* not a number yet */ } const now = Date.now(); const deps = this.recentDeposits(sym);
    const same = v > 0n && deps.find((x) => { const a = BigInt(x.amount); const dd = a > v ? a - v : v - a; return dd * 100n <= a; }); // equal, or within 1%
    if (same) out.push({ id: 'amount', text: (BigInt(same.amount) === v ? 'This is the same amount' : 'This is almost the same amount') + ` you deposited ${agoText(now - same.at)}. A different amount, or a few smaller withdrawals, is harder to match.` });
    const last = deps[0]; if (last && now - last.at < LINK_SOON) out.push({ id: 'timing', text: `You deposited ${sym} ${agoText(now - last.at)}. Waiting longer lets more deposits and withdrawals happen in between.` });
    const n = crowd.token != null ? crowd.token : crowd.total; const what = crowd.token != null ? `private ${sym} deposit` : 'private deposit';
    if (n != null && n < CROWD_MIN) out.push({ id: 'crowd', text: (n === 0 ? `No ${what}s yet, so there is nobody to blend in with.` : `Only ${n} ${what}${n === 1 ? '' : 's'} so far, so there are few to blend in with.`) + ' Privacy gets stronger as more people use Veyl.' });
    return { warnings: out, tip: NETWORK_TIP, crowd };
  };
}
Engine.CROWD_MIN = CROWD_MIN;
Engine.acceptMints(Engine.prototype); // after the safety rails: they wrap deposit / shieldDeposit, and their logs key by symbol
export { PrivacyError, BackupRequiredError, PoolError, H, merklePath, PublicKey, Keypair, Veyl, Store };
export const Shield = Z;
export { Market, parsePyth, parseJupiter, parseCandles, MARKET_ORIGINS, Markets, MARKET_SOURCES, MARKETS_ORIGINS, mergeRows };
export const SDK = { shapeWeights, sideWeights, distribute, priceOf, chunkOf };

// ------------------------------------------------------------- Sandbox: the same engine on an in-browser chain (play money)
import { makeSandbox } from './sandbox-engine.js';
export const Sandbox = makeSandbox(Engine, PrivacyError, Store);
Engine.acceptMints(Sandbox.prototype);
