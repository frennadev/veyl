// Veyl Sandbox engine: the app's own Engine (every shielded, sealed and liquidity flow is the real one: the same notes,
// witnesses, Groth16 proofs, ciphertexts and request formats), pointed at the in-browser chain (sandbox-chain.js) instead
// of an RPC node and a relayer. Proofs are generated in a Web Worker and verified with snarkjs against the circuits'
// verifying keys before the sandbox applies anything. Nothing is sent anywhere; balances are play money.
import { Buffer } from 'buffer';
import { PublicKey, Keypair } from '@solana/web3.js';
import { sha256 } from 'js-sha256';
import { SandboxChain, keyFrom, ser, deser, fmtA, short } from './sandbox-chain.js';
import { TOKENS, POOLS, FEES, PRICES_AS_OF } from './sandbox-config.js';
import { Market } from './market.js';
const S = require('../sdk/veyl.js');
const Z = require('../sdk/shield.js');
const SE = require('../sdk/sealed.js');
const J = require('../sdk/bjj.js');
const { chunkOf, slotOf, priceOf, shapeWeights, sideWeights, distribute, BINS_PER_ARRAY } = S;
const b58 = (k) => new PublicKey(k).toBase58();
const B64 = (u) => Buffer.from(u).toString('base64');
const CHAIN_KEY = 'veyl:sandbox:chain', VERSION = 6;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* nothing stored */ } };
/// Typical proving time per circuit on a laptop (ms), until this device has its own measurements.
const TYPICAL = { transact: 3000, position: 7000, swap: 6000, claim: 2500 };
const SEALED_CAP = { SOL: 25, USDC: 20000, USDT: 20000 };

export function makeSandbox(Engine, PrivacyError, Store) {
  class Sandbox extends Engine {
    /// opts: { zk: { circuit: { wasm, zkey: [parts], size } }, vkeys: url | object, proverWorker, committeeWorker, snarkjs,
    ///         prove: async (circuit, input) => { proof, publicSignals } (tests), persist: true, bots: true }
    constructor(opts = {}) {
      const box = {}; const chain = new SandboxChain({ tokens: TOKENS, pools: POOLS, verify: (c, p) => box.self._verify(c, p) });
      chain.poolCfg.forEach((c) => { c.address = chain.V.binPoolPda(new PublicKey(chain.tokens[c.x].mint), new PublicKey(chain.tokens[c.y].mint), c.binStep).toBase58(); });
      const tokens = {}; for (const t of TOKENS) tokens[t.sym] = { mint: chain.tokens[t.sym].mint, decimals: t.decimals, name: t.name };
      const cfg = { chainName: 'Demo', sandbox: true, rpc: 'http://sandbox.invalid', explorer: null, programs: chain.programs, tokens, zk: opts.zk || {}, proverWorker: opts.proverWorker || 'prove-worker.js',
        binPools: POOLS.map((c) => ({ id: c.id, address: c.address, x: c.x, y: c.y, binStep: c.binStep, baseFee: c.baseFee, bs: c.binStep, base: c.baseFee / 10000, category: c.category, sealed: !!c.sealed, reward: c.reward ? c.reward.sym : null })) };
      super(cfg); box.self = this; this.chain = chain; this.market = new Market(opts.fetch ? { fetch: opts.fetch } : {}); this.opts = opts; this.V = chain.V; this.sandbox = true;
      this._proofs = new Map(); this.proving = null; this.listeners = new Set(); this.lastVerify = null;
      this._wire(); this._boot();
    }
    // ------------------------------------------------------------------------------------------ chain reads (as sdk/veyl.js returns them)
    _wire() { const ch = this.chain, V = this.V;
      const cloneBin = (b) => ({ ...b, rewardG: [...b.rewardG] });
      V.binPool = async (pool) => { const P = ch.pools.get(b58(pool)); if (!P) return null; const p = P.p; return { ...p, bitmapX: [...p.bitmapX], bitmapY: [...p.bitmapY], rewards: p.rewards.map((r) => ({ ...r })) }; };
      V.bins = async (pool, chunks) => { const P = ch.pool(pool); const m = new Map(); m.chunks = new Set(chunks); for (const c of chunks) for (let s = 0; s < BINS_PER_ARRAY; s++) { const b = P.bins.get(c * BINS_PER_ARRAY + s); if (b) m.set(b.id, cloneBin(b)); } return m; };
      V.shareAccount = async (pool, owner, auth, chunk) => { const a = ch.shareAcc(ch.pool(pool), owner, auth, chunk, false); if (!a) return null; return { ...a, pendingReward: [...a.pendingReward], slots: a.slots.map((s) => ({ ...s, rewardCp: [...s.rewardCp] })) }; };
      V.lpAcc = async (pool, chunk) => { const a = ch.lpacc.get(b58(pool) + ':' + chunk); return a ? { chunk, hx: [...a.hx], hy: [...a.hy] } : null; };
      V.tokenProgram = async () => S.TOKEN_PROGRAM;
      V.currentFee = async (pool) => ch.feeNow(ch.pool(pool));
      V.events = async (id) => ch.events.get(id) || [];
      V.tokenBalance = async (mint, owner) => { const t = ch.sym(mint); return t ? ch.bal(owner, t.sym) : 0n; };
      V.batch = async (pool, seq) => ch.batch(pool, seq);
      V.claimTerms = async (pool, seq, d) => ch.claimTerms(pool, seq, d);
      V.nonce = async () => 0n;
      V.factory = async () => { const f = ch.factory; return { ...f, tiers: f.tiers.map((t) => ({ ...t })) }; };
      V.bond = async (pool) => { const b = ch.bonds.get(b58(pool)); return b ? { ...b } : null; };
      this.conn = { getSlot: async () => ch.slot(), getBalance: async () => 0, getSignaturesForAddress: async () => [] };
      ch.listeners.add((e) => { this._dirty = true; this._emit(e); });
    }
    _boot() { const raw = this.opts.persist === false ? null : lsGet(CHAIN_KEY); let ok = false;
      if (raw) { try { const o = deser(raw); if (o.v === VERSION) { this.chain.load(o); ok = true; } } catch { ok = false; } }
      this._fresh = !ok; if (!ok) { this._dirty = true; this.store.data.shield = { orders: [], pending: [], meta: {} }; this.store.data.positions = []; this.store.data.orders = []; this.store.data.activity = []; this.store.save(); this.shieldInit(); }
      const sb = this.store.data.sandbox || (this.store.data.sandbox = {}); if (!sb.wallet) { sb.wallet = Keypair.generate().publicKey.toBase58(); sb.createdAt = Date.now(); this.store.save(); }
      this.pk = new PublicKey(sb.wallet); this.account = sb.wallet; this.wallet = { sandbox: true };
      for (const P of this.chain.pools.values()) if (P.cfg.user) this._userRow(P);
      this.friend = new Z.ShieldWallet(Buffer.from(sha256.arrayBuffer('veyl-sandbox:mara')), { mints: {}, pools: [] }); }
    /// Ready to use: live market prices fetched (Pyth, then Jupiter; a few seconds at most), and on a first visit the play
    /// world seeded at those prices along the real last 24 hours. Without a market, fallback prices and a quiet note.
    init() { if (this._ready) return this._ready; this._ready = (async () => {
        const m = this.market; let usd = {};
        if (this.opts.market !== false) { try { const pr = await m.refresh(); usd = Object.fromEntries(Object.entries(pr).map(([k, v]) => [k, v.usd])); } catch { usd = {}; } }
        if (this._fresh) { let hist = {};
          if (Object.keys(usd).length && this.opts.history !== false) { const syms = ['SOL', 'USDT', 'JUP']; const hs = await Promise.all(syms.map((x) => Promise.race([m.history(x, 86400), new Promise((r) => setTimeout(() => r([]), 6000))])));
            syms.forEach((x, i) => { if (hs[i] && hs[i].length > 20) hist[x] = hs[i]; }); }
          this.chain.seed(usd, hist); this._fresh = false; this._dirty = true; this.save(); }
        if (Object.keys(usd).length) { this.chain.setMarket(usd); this.chain.catchUp(); this._dirty = true; } this._emit({ type: 'market' }); return this; })(); return this._ready; }
    marketInfo() { const m = this.market; return { live: !m.error && Object.keys(m.prices).length > 0, source: m.source, at: m.at, error: m.error, anchored: this.chain.anchored, asOf: PRICES_AS_OF, label: (sym) => m.label(sym) }; }
    /// Bots, deposits admitted, batches closing and settling, state saved. Call once the page is ready.
    start() { if (this._timers) return; const ch = this.chain; this._timers = [];
      const every = (ms, f) => this._timers.push(setInterval(() => { try { f(); } catch (e) { /* a sandbox tick failing must not stop the others */ } }, ms));
      every(1000, () => { ch.approveDeposits(2500); ch.tickSealed((M) => this._dlog(M)); });
      if (this.opts.bots !== false) { const bot = () => { this._timers.push(setTimeout(() => { if (!this._paused) { try { ch.botTrade(); } catch { /* skip */ } } bot(); }, 3500 + Math.random() * 5000)); }; bot();
        every(2000, () => { if (!this._paused) ch.botSealTick(); }); }
      every(4000, () => this.save());
      if (this.opts.market !== false) every(30000, () => { this.market.refresh().then((pr) => { this.chain.setMarket(Object.fromEntries(Object.entries(pr).map(([k, v]) => [k, v.usd]))); for (const P of this.chain.pools.values()) this.chain.mmTick(P); this._emit({ type: 'market' }); }).catch(() => this._emit({ type: 'market' })); }); if (typeof window !== 'undefined') window.addEventListener('pagehide', () => this.save()); }
    stop() { for (const t of this._timers || []) { clearInterval(t); clearTimeout(t); } this._timers = null; }
    save() { if (!this._dirty || this.opts.persist === false || this._wiped) return; this._dirty = false; this.persisted = lsSet(CHAIN_KEY, ser(this.chain.toJSON())); }
    /// Everything back to the start: the chain, the practice wallet, the shielded account.
    reset() { this.stop(); this._wiped = true; lsDel(CHAIN_KEY); try { localStorage.removeItem(this.store.key); } catch { /* nothing stored */ } }
    on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
    _emit(e) { for (const f of this.listeners) { try { f(e); } catch { /* listener */ } } }
    pause(v) { this._paused = !!v; }

    // ------------------------------------------------------------------------------------------ wallet, faucet
    static wallets() { return [['Demo wallet', { sandbox: true }]]; }
    async connect() { return this.account; }
    async ping() { await this.init(); return this.chain.slot(); }
    async solBalance() { return this.chain.bal(this.pk, 'SOL'); }
    async faucet() { const zw = this.zw || this.shieldInit(); const o = SandboxChain.FAUCET_SHIELDED.map(() => zw.nextOneTime()); this.store.data.shield.ot = zw.ot; this.store.save();
      const tx = this.chain.faucet(this.pk, o); await this.shieldSync(); this._dirty = true; this.save(); return { tx }; }
    friendAddress() { return this.friend.address; }
    friendBalance(sym) { this.friend.scan(this._shieldView()); return this.friend.balance(this.tok(sym).mint); }
    receipt(id) { return this.chain.log.find((x) => x.id === id) || null; }
    activityLog() { return this.chain.log; }

    // ------------------------------------------------------------------------------------------ proofs: worker, progress, verification
    async _vkeys() { if (this._vk) return this._vk; const v = this.opts.vkeys; this._vk = typeof v === 'string' ? await fetch(v).then((r) => r.json()) : v; return this._vk; }
    _snark() { const s = this.opts.snarkjs || (typeof window !== 'undefined' && window.snarkjs); if (!s) throw new Error('snarkjs is not loaded'); return s; }
    expectedMs(circuit) { const m = (this.proveMs && this.proveMs[circuit]) || []; return m.length ? m.reduce((a, b) => a + b, 0) / m.length : TYPICAL[circuit] * (this.slowDevice ? 3 : 1); }
    _progress(p) { this.proving = p ? { ...this.proving, ...p } : null; this._emit({ type: 'proving', proving: this.proving }); }
    async _proveRaw(circuit, input) {
      if (this.opts.prove) return this.opts.prove(circuit, input);
      const zk = this.cfg.zk[circuit]; if (!zk) throw new Error('This page has no ' + circuit + ' circuit.');
      const abs = (u) => new URL(u, location.href).href; const parts = (Array.isArray(zk.zkey) ? zk.zkey : [zk.zkey]).map(abs);
      if (typeof Worker !== 'undefined' && this.opts.worker !== false) {
        if (!this._worker) { try { this._worker = new Worker(this.cfg.proverWorker); this._wq = new Map(); this._wid = 0;
          this._worker.onmessage = (e) => { const d = e.data; const q = this._wq.get(d.id); if (!q) return; if (d.progress) { this._progress(d.progress); return; } this._wq.delete(d.id); d.error ? q.rej(new Error(d.error)) : q.res(d); };
          this._worker.onerror = () => { for (const q of this._wq.values()) q.rej(new Error('The proving worker stopped.')); this._wq.clear(); this._worker = null; }; } catch { this._worker = null; } }
        if (this._worker) { const id = ++this._wid; return new Promise((res, rej) => { this._wq.set(id, { res, rej }); this._worker.postMessage({ id, circuit, input, wasm: abs(zk.wasm), zkey: parts, size: zk.size || 0 }); }); } }
      // no worker: the main thread (the page pauses while it proves)
      this._progress({ stage: 'fetch', loaded: 0, total: zk.size || 0 });
      const bufs = []; for (const u of parts) bufs.push(new Uint8Array(await fetch(u).then((r) => r.arrayBuffer())));
      const zkey = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0)); let o = 0; for (const b of bufs) { zkey.set(b, o); o += b.length; }
      this._progress({ stage: 'prove' }); return this._snark().groth16.fullProve(input, abs(zk.wasm), zkey); }
    async proveIn(circuit, input) {
      this.log('Generating the proof on your device'); const t0 = Date.now(); this._progress({ circuit, stage: 'start', t0, expect: this.expectedMs(circuit) });
      let out; try { out = await this._proveRaw(circuit, input); } finally { this._progress(null); }
      const ms = Date.now() - t0; this.proveMs[circuit].push(ms); this.lastProof = { circuit, ms, worker: !!this._worker };
      const p = Z.packProofN(out.proof, out.publicSignals, circuit === 'claim' ? 6 : 8); while (p.pubs.length < 8) p.pubs.push(0n);
      const packed = { proof: B64(p.proof), pubs: p.pubs.map(String), ms }; this._proofs.set(packed.proof, { circuit, proof: out.proof, publicSignals: out.publicSignals.map(String), ms });
      if (this._proofs.size > 40) this._proofs.delete(this._proofs.keys().next().value); return packed; }
    /// The sandbox chain's verifier: the Groth16 proof behind these bytes, checked with snarkjs against the circuit's
    /// verifying key, and its public signals checked against the ones the instruction carries.
    async _verify(circuit, p) { const raw = this._proofs.get(p.proof); if (!raw || raw.circuit !== circuit) return { ok: false, circuit };
      const n = raw.publicSignals.length; if (!raw.publicSignals.every((s, i) => String(BigInt(s)) === String(BigInt(p.pubs[i])))) return { ok: false, circuit };
      for (let i = n; i < p.pubs.length; i++) if (BigInt(p.pubs[i]) !== 0n) return { ok: false, circuit };
      const vk = (await this._vkeys())[circuit]; this.log('Verifying the proof (snarkjs, the ' + circuit + ' verifying key)'); const t = performance.now();
      const ok = await this._snark().groth16.verify(vk, raw.publicSignals, raw.proof); const verifyMs = Math.round(performance.now() - t);
      const r = { ok: !!ok, circuit, ms: raw.ms, verifyMs }; this.lastVerify = r; this._emit({ type: 'verified', ...r }); return r; }
    async _dlog(M) { if (typeof Worker !== 'undefined' && this.opts.committeeWorker) {
        if (!this._cw) { this._cw = new Worker(this.opts.committeeWorker); this._cq = new Map(); this._cid = 0; this._cw.onmessage = (e) => { const q = this._cq.get(e.data.id); if (q) { this._cq.delete(e.data.id); q(e.data.m === null ? null : BigInt(e.data.m)); } }; }
        const id = ++this._cid; return new Promise((res) => { this._cq.set(id, res); this._cw.postMessage({ id, M: M.map(String) }); }); }
      return J.bsgsAuto(M, 36); }

    // ------------------------------------------------------------------------------------------ the relayer, in this page
    async relayerInfo() { return { address: this.chain.relayer.toBase58(), minFeeBps: 0, sandbox: true }; }
    async shieldFee(kind, sym) { const f = FEES[sym]; if (f === undefined) throw new Error('No relayer fee for ' + sym + '.'); return f; }
    async feeFor() { return 0; }
    async submit(req) { this.log('Relayer submits it. Your wallet never touches this transaction'); const ch = this.chain; let r;
      switch (req.kind) {
        case 'transact': r = await ch.shieldTransact(req.ext, req.p, req.recipientOwner ? new PublicKey(req.recipientOwner) : null); break;
        case 'shieldSwap': r = await ch.shieldSwap(req.core, req.leg); break;
        case 'shieldLp': r = await ch.shieldLp(req.core, req.legs, req.position); break;
        case 'shieldOrder': r = await ch.shieldOrder(req.core, req.leg); break;
        case 'shieldOrderWithdraw': r = await ch.shieldOrderWithdraw(req.core, req.leg); break;
        case 'sealedSwap': r = await ch.submitSwap(req); break;
        case 'sealedClaim': r = await ch.claimSwap(req); break;
        default: throw new Error('The sandbox does not run ' + req.kind + '.'); }
      this.lastTx = r.txHash; return r; }
    _shieldView() { const sh = this.chain.shield; return { tree: sh.tree, leaves: sh.tree.leaves, ciphertexts: sh.ciphertexts, receipts: sh.receipts, nullified: sh.nullified, pending: sh.pending }; }
    async shieldSync() { const zw = this.zw || this.shieldInit(); const st = this._shieldView(); zw.scan(st); this.shieldState = st; this.store.data.shield.ot = zw.ot; if (zw.notes.length) this.store.data.shield.used = true;
      this.shieldPendingNow = st.pending.filter((p) => p.depositor === this.account).map((p) => ({ ...p }));
      this.store.data.shield.pending = (this.store.data.shield.pending || []).filter((p) => this.shieldPendingNow.some((q) => q.commitments.includes(String(p.commitment)))); this.store.save(); return zw.notes; }
    async shieldDeposit(sym, amount) { const zw = this.zw || this.shieldInit(); await this.shieldSync(); const v = this.unit(sym, amount); if (v <= 0n) throw new Error('Enter an amount.');
      if (this.chain.bal(this.pk, sym) < v) throw new Error('Not enough ' + sym + ' in your wallet. Top up from the account menu.');
      const mint = new PublicKey(this.tok(sym).mint); const d = zw.deposit(mint, v); const p = await this.proveIn('transact', d.input);
      this.log('Your wallet signs the deposit'); const r = await this.chain.shieldDeposit(this.pk, d.ext, p);
      this.store.data.shield.pending.push({ commitment: String(d.commitments[0]), sym, amount: String(v), tx: r.tx, at: Date.now() }); this.store.save(); this.lastTx = r.tx; return { tx: r.tx, value: v }; }
    async cancelDeposit() { throw new Error('Deposits are admitted after a few seconds; there is nothing to cancel.'); }
    async guardRecipient(addr) { let k; try { k = new PublicKey(addr); } catch { throw new PrivacyError('That is not a valid Solana address.'); }
      if (k.toBase58() === this.account) throw new PrivacyError('That is your own wallet. Sending there links the two. Use a fresh address.');
      if (this.chain.balances.has(k.toBase58())) throw new PrivacyError('That address has a history in the sandbox. A fresh, unused address keeps you private.'); }
    freshAddress() { return Keypair.generate().publicKey.toBase58(); }
    async sealedState(pool) { const ch = this.chain; const addr = b58(pool.address || pool); const s = ch.sealed.get(addr); if (!s) return { enabled: false };
      const P = ch.pool(addr); const pub = (x) => x && { seq: String(x.seq), state: x.state, count: [...x.count], rollovers: x.rollovers, endSlot: String(x.endSlot), closedSlot: String(x.closedSlot), verified: x.verified, totals: x.totals.map(String), num: x.num.map(String), den: x.den.map(String), xForY: x.xForY, decryptMs: x.decryptMs || null, bots: x.bots.length };
      const b = s.batches.get(s.seq); const last = [...s.batches.values()].filter((x) => x.seq < s.seq && x.state !== 'open').sort((a, c) => c.seq - a.seq)[0] || null;
      return { enabled: true, slot: ch.slot(), slotMs: 400, paused: false, mintX: ch.tokens[P.x].mint, mintY: ch.tokens[P.y].mint, seq: String(s.seq), epochSlots: String(s.epochSlots), settleTimeout: String(s.settleSlots), minIn: s.minIn.map(String), kMin: s.kMin, maxRollovers: s.maxRollovers,
        batch: pub(b), last: pub(last), committee: { t: 2, n: 3, epoch: 1, kind: 0, pk: J.enc(ch.committee.PK).toString('hex'), sandbox: true } }; }
    async sealedSwap(pool, o) { const sym = o.xIn ? pool.x : pool.y; if (Number(o.amount) > (SEALED_CAP[sym] || Infinity)) throw new Error('In the sandbox a sealed swap is at most ' + SEALED_CAP[sym] + ' ' + sym + ' (the committee\'s decryption range here).');
      const st = await this.sealedState(pool); this.chain.hold(pool.address, st.seq);
      try { return await super.sealedSwap(pool, o); } finally { this.chain.holds.delete(b58(pool.address) + ':' + st.seq); } }

    // ------------------------------------------------------------------------------------------ pools anyone lists (pools-engine.js hooks)
    _userRow(P) { const row = { id: P.id, x: P.x, y: P.y, bs: P.cfg.binStep, base: P.cfg.baseFee / 10000, binStep: P.cfg.binStep, baseFee: P.cfg.baseFee, address: P.address, mintX: b58(P.p.mintX), mintY: b58(P.p.mintY), discovered: true };
      const i = this.cfg.binPools.findIndex((b) => b.address === P.address); if (i >= 0) this.cfg.binPools[i] = { ...this.cfg.binPools[i], ...row }; else this.cfg.binPools.push(row); if (this.zw) this.zw.addPool({ address: P.address, mintX: row.mintX, mintY: row.mintY, x: P.x, y: P.y }); return row; }
    async _readMint(m) { const t = this.chain.sym(m); return t ? { program: 'spl', decimals: t.decimals, initialized: true, supply: 0n, mintAuthority: null, freezeAuthority: null, extensions: [], metadata: null } : null; }
    async _discover() { return Promise.all([...this.chain.pools.keys()].map((a) => this.V.binPool(a))); }
    async _bonds(addrs) { return addrs.map((a) => { const b = this.chain.bonds.get(b58(a)); return b ? { ...b } : null; }); }
    async _poolKeys() { return [...this.chain.pools.keys()]; }
    /// The demo pools keep their config order (not canonical), so their addresses come from (x, y) as listed: look both ways.
    async poolFor(mintA, mintB, tierId) { const t = this.chain.factory.tiers[Number(tierId)]; if (!t) return null; let a, b; try { a = new PublicKey(mintA); b = new PublicKey(mintB); } catch { return null; } if (a.equals(b)) return null;
      for (const [p, q] of [[a, b], [b, a]]) { const addr = this.V.binPoolPda(p, q, t.binStep).toBase58(); if (this.chain.pools.has(addr)) return addr; } return null; }
    async _createPoolExec({ x, y, tier, basePrice, bond }) { const ch = this.chain; const sx = ch.sym(x).sym, sy = ch.sym(y).sym;
      if (await this.poolFor(x, y, tier.index)) throw new Engine.PoolError('POOL_EXISTS', 'This pool already exists.');
      if (ch.bal(this.pk, 'SOL') < bond) throw new Engine.PoolError('BOND_LOW', 'Creating this pool takes the ' + Number(bond) / 1e9 + ' SOL bond (refundable after the lock). Top up from the account menu.');
      this.log('Confirm in your wallet'); this.log('Sending…'); let P; try { P = ch.createUserPool(this.pk, sx, sy, tier.index, basePrice); } catch (e) { throw /exists/.test(e.message) ? new Engine.PoolError('POOL_EXISTS', 'This pool already exists.') : e; }
      this._userRow(P); this._dirty = true;
      const tx = ch.tx('create_pool', [{ name: 'PoolCreated', pool: new PublicKey(P.address), binStep: tier.binStep, baseFee: tier.baseFee, tier: tier.index, creator: this.pk, bond }], this._pub('create', [['Create pool', sx + '–' + sy + ' at ' + S.tierLabel(tier.binStep, tier.baseFee)], ['Bond', fmtA(ch, 'SOL', bond) + ', refundable after ' + Number(ch.factory.bondLock) / 86400 + ' days']], [['Nothing', 'listing a pool is public: the pair, the tier, the price and who paid the bond']]));
      this.lastTx = tx; return { tx }; }
    async _releaseBondExec(pool) { const ch = this.chain; this.log('Confirm in your wallet'); this.log('Sending…'); const a = ch.releaseBond(this.pk, pool); this._dirty = true;
      const tx = ch.tx('release_bond', [{ name: 'BondReleased', pool, creator: this.pk, amount: a }], this._pub('bond', [['Bond released', fmtA(ch, 'SOL', a) + ' back to the wallet']])); this.lastTx = tx; return { tx }; }

    // ------------------------------------------------------------------------------------------ pools
    async poolState(addr, span = 35) { const ch = this.chain; const P = ch.pool(addr); const bp = await this.V.binPool(addr); const c = this.poolCfg(addr); const a = bp.activeId; const now = Math.floor(Date.now() / 1000);
      const bins = {}; for (let i = a - span; i <= a + span; i++) { const x = P.bins.get(i); bins[i] = x ? { x: x.x, y: x.y, shares: x.shares, askX: x.askX || 0n, bidY: x.bidY || 0n } : { x: 0n, y: 0n, shares: 0n, askX: 0n, bidY: 0n }; }
      const rewards = bp.rewards.map((r, i) => (r.initialized ? { index: i, sym: this.symOf(r.mint) || null, mint: r.mint.toBase58(), live: Number(r.end) > now && r.rate > 0n, end: Number(r.end), ratePerSec: r.rate >> 64n } : null)).filter(Boolean);
      return { address: b58(addr), x: c.x, y: c.y, binStep: bp.binStep, baseFee: bp.baseFee, fee: Number(ch.feeNow(P)), active: a, price: priceOf(bp.basePrice, bp.binStep, a), bp, bins,
        reserves: { x: P.vault.x - bp.protocolFeeX, y: P.vault.y - bp.protocolFeeY }, totalFees: { x: bp.totalFeeX, y: bp.totalFeeY }, protocolShare: 0, protocolFeeBps: bp.protocolFeeBps, tier: this._poolTier(bp), status: await this.poolStatus(addr, bp), rewards, seeded: bp.seeded }; }
    /// Live stats from the sandbox state: 24h volume and fees, liquidity, all in the quote token and in play dollars.
    /// Live stats from the sandbox state over the last `secs` (default 24h), in play dollars: volume, fees (all and to LPs), APR
    /// (LP fees over the window, annualised, over liquidity), fees / liquidity, 24h price change, age, depth near the price, Score.
    poolStats(addr, secs = 86400) { const ch = this.chain; const P = ch.pool(addr); const v = ch.stats(P, secs); const px = ch.humanPrice(P); const ux = this.usdOf(P.x), uy = this.usdOf(P.y);
      const X = (a) => this.fmt(P.x, a), Y = (a) => this.fmt(P.y, a); const usd = (ax, ay) => X(ax) * ux + Y(ay) * uy;
      const tvl = usd(P.vault.x - P.p.protocolFeeX, P.vault.y - P.p.protocolFeeY); const fees = usd(v.feeX, v.feeY), lp = usd(v.lpX, v.lpY);
      const h = ch.history(P, secs); const p0 = ch.humanPrice(P, h.start); const a = P.p.activeId;
      let near = 0, all = 0; for (const b of P.bins.values()) { const val = X(b.x) * ux + Y(b.y) * uy; all += val; if (Math.abs(b.id - a) <= 10) near += val; }
      const apr = tvl > 0 ? (lp / tvl) * (31_536_000 / secs) * 100 : 0; const depth = all > 0 ? near / all : 0;
      return { price: px, change: p0 > 0 ? (px / p0 - 1) * 100 : 0, active: a, fee: Number(ch.feeNow(P)), volumeUsd: usd(v.x, v.y), feesUsd: fees, lpFeesUsd: lp, tvlUsd: tvl, swaps: v.count,
        aprPct: apr, feeTvlPct: tvl > 0 ? (fees / tvl) * 100 : 0, depth, score: apr * depth, ageSec: Math.max(0, Math.floor(Date.now() / 1000) - P.createdAt),
        spark: h.pts.map((q) => ch.humanPrice(P, q.id)), sparkT: h.pts.map((q) => q.t), start: p0 }; }
    /// Dollars per token: the live market price; without one, the sandbox's own (its pools against USDC, or the fallback).
    usdOf(sym) { const m = this.market.usd(sym); if (m) return m; const ch = this.chain; if (sym === 'USDC') return 1;
      const P = [...ch.pools.values()].find((q) => q.x === sym && q.y === 'USDC'); if (P) return ch.humanPrice(P); return (ch.usd && ch.usd[sym]) || (ch.tokens[sym] && ch.tokens[sym].price) || 0; }

    // ------------------------------------------------------------------------------------------ public actions (the practice wallet signs)
    _pub(kind, rows, hidden = [['Nothing', 'a public action shows the signer, the amounts and the position']]) { return { pub: [['Signer', 'your wallet ' + short(this.account)], ...rows], hidden }; }
    async swapPublic(symIn, symOut, amountIn, { slippageBps = 100 } = {}) { const v = this.unit(symIn, amountIn); const best = await this.quoteRoute(symIn, symOut, v); if (!best) throw new Error('No route with liquidity for that pair.');
      this.log('Your wallet signs'); const r = this.chain.swapRoute(this.pk, symIn, symOut, best.path.map((h) => ({ pool: h.pool, xForY: h.xForY })), v, best.out - (best.out * BigInt(slippageBps)) / 10000n);
      const tx = this.chain.tx('swap', [], this._pub('swap', [['Swap', fmtA(this.chain, symIn, v) + ' → ' + fmtA(this.chain, symOut, r.out)], ['Route', r.route.join(' → ')]])); this.lastTx = tx; return { tx, out: r.out, route: best.path.map((h) => h.name) }; }
    async addLiquidity(pool, o) { if (o.priv) return super.addLiquidity(pool, o);
      const addr = pool.address; const pk = new PublicKey(addr); const st = await this.poolState(addr, 1); const shape = o.shape === 'bidask' ? 'bidAsk' : o.shape || 'spot';
      const lo = o.lo !== undefined ? o.lo : st.active - o.range, hi = o.hi !== undefined ? o.hi : st.active + o.range; if (hi < lo) throw new Error('Pick a range.');
      const ax = o.amountX > 0 ? this.unit(pool.x, o.amountX) : 0n, ay = o.amountY > 0 ? this.unit(pool.y, o.amountY) : 0n; const pl = this.plan(st, lo, hi, shape, ax, ay); if (!pl.ids.length) throw new Error(this._sideHint(st, lo, hi, ax, ay));
      const owner = Keypair.generate().publicKey; const minShares = await this.minSharesFor(pk, pl.ids, pl.xs, pl.ys, o.slippageBps || 100); this.log('Your wallet signs');
      this.chain.mint(this.chain.pool(addr), this.pk, owner, this.pk, pl.ids, pl.xs, pl.ys, minShares);
      const tx = this.chain.tx('mint', [], this._pub('mint', [['Add liquidity', fmtA(this.chain, pool.x, pl.xs.reduce((a, b) => a + b, 0n)) + ' + ' + fmtA(this.chain, pool.y, pl.ys.reduce((a, b) => a + b, 0n))], ['Bins', pl.ids[0] + ' … ' + pl.ids[pl.ids.length - 1] + ' (' + pl.ids.length + '), ' + shape]])); this.lastTx = tx;
      return this._savePos({ id: 'q' + Date.now(), kind: 'public', pool: addr, x: pool.x, y: pool.y, owner: owner.toBase58(), authority: this.account, ids: pl.ids, lo, hi, shape, createdAt: Date.now(), tx }); }
    async zap(pool, o) { if (o.priv) return super.zap(pool, o);
      const addr = pool.address; const pk = new PublicKey(addr); const st = await this.poolState(addr, 1); const shape = o.shape === 'bidask' ? 'bidAsk' : o.shape || 'spot';
      const ids = []; for (let i = o.lo; i <= o.hi; i++) ids.push(i); const w = shapeWeights(ids, st.active, shape); const sym = o.xIn ? pool.x : pool.y; const amt = this.unit(sym, o.amount);
      const plan = await this.V.planZap(pk, { xIn: !!o.xIn, amountIn: amt, ids, ...w, slippageBps: o.slippageBps || 200 }); const owner = Keypair.generate().publicKey; this.log('Your wallet signs');
      const r = this.chain.swapAndAdd(this.chain.pool(addr), this.pk, owner, this.pk, !!o.xIn, amt, plan.swapAmount, plan.minSwapOut, ids, w.weightsX, w.weightsY, plan.minShares);
      const tx = this.chain.tx('swap_and_add', [], this._pub('zap', [['Zap', fmtA(this.chain, sym, amt) + ' in; ' + fmtA(this.chain, sym, plan.swapAmount) + ' swapped for ' + fmtA(this.chain, o.xIn ? pool.y : pool.x, r.swapOut)], ['Bins', o.lo + ' … ' + o.hi + ', ' + shape]])); this.lastTx = tx;
      return this._savePos({ id: 'q' + Date.now(), kind: 'public', pool: addr, x: pool.x, y: pool.y, owner: owner.toBase58(), authority: this.account, ids, lo: o.lo, hi: o.hi, shape, zap: true, createdAt: Date.now(), tx }); }
    async removeLiquidity(pos, pct, opt) { if (pos.kind !== 'public') return super.removeLiquidity(pos, pct, opt);
      const i = await this.positionInfo(pos); const sh = i.shares.map((s) => (s * BigInt(pct)) / 100n); const keep = pos.ids.filter((_, k) => sh[k] > 0n); if (!keep.length) throw new Error('Nothing left to withdraw in this position.');
      this.log('Your wallet signs'); const o = this.chain.burn(this.chain.pool(pos.pool), this.pk, new PublicKey(pos.owner), keep, sh.filter((s) => s > 0n));
      const tx = this.chain.tx('burn', [], this._pub('burn', [['Remove ' + pct + '%', fmtA(this.chain, pos.x, o.x) + ' + ' + fmtA(this.chain, pos.y, o.y) + ' to the wallet']])); this.lastTx = tx; return { tx, x: o.x, y: o.y, notes: [] }; }
    async claimFees(pos, opt) {
      if (pos.kind === 'shielded') { try { return await super.claimFees(pos, opt); } catch (e) { if (!/smaller than the relayer/.test(e.message)) throw e;
        // fees earned since the last shielded action in these bins are not in the window's growth yet: a no-change action
        // (its leg pays the relayer) harvests them, then the claim proves against the new growth
        const info = await this.positionInfo(pos); if (info.fees.x === 0n && info.fees.y === 0n) throw e;
        this.log('Collecting the fees earned since the last shielded action first'); await this._lp(pos.pool, pos.windowLo, Array(Z.K).fill(0n), { legs: [{ sym: pos.y, amount: 0n, fee: FEES[pos.y] }] });
        return super.claimFees(pos, opt); } }
      if (pos.kind !== 'public') return super.claimFees(pos, opt);
      const i = await this.positionInfo(pos); if (i.fees.x === 0n && i.fees.y === 0n) throw new Error('This position has no fees to claim yet.'); this.log('Your wallet signs');
      const o = this.chain.claimFees(this.chain.pool(pos.pool), this.pk, new PublicKey(pos.owner), pos.ids); const tx = this.chain.tx('claim_fees', [], this._pub('claim', [['Fees claimed', fmtA(this.chain, pos.x, o.x) + ' + ' + fmtA(this.chain, pos.y, o.y)]])); this.lastTx = tx; return { tx, x: o.x, y: o.y }; }
    async claimReward(pos, index, opt) { if (pos.kind !== 'public') return super.claimReward(pos, index, opt);
      const P = this.chain.pool(pos.pool); const sym = this.chain.sym(P.p.rewards[index].mint).sym; this.log('Your wallet signs');
      const a = this.chain.claimReward(P, this.pk, new PublicKey(pos.owner), index, pos.ids); if (a === 0n) throw new Error('This position has no rewards to claim yet.');
      const tx = this.chain.tx('claim_reward', [], this._pub('reward', [['Farm reward claimed', fmtA(this.chain, sym, a)]])); this.lastTx = tx; return { tx, amount: a, sym }; }
    async rebalance(pos, o) { if (pos.kind !== 'public') return super.rebalance(pos, o); const shape = o.shape === 'bidask' ? 'bidAsk' : o.shape || 'spot'; const { lo, hi } = o;
      const pk = new PublicKey(pos.pool); const i = await this.positionInfo(pos); const burnIds = pos.ids.filter((_, k) => i.shares[k] > 0n), burnShares = i.shares.filter((s) => s > 0n); if (!burnIds.length) throw new Error('This position is empty.');
      const ids = []; for (let k = lo; k <= hi; k++) ids.push(k); if (ids.length > 41) throw new Error('A rebalance moves to at most 41 bins at once.'); const st = await this.poolState(pos.pool, 1); const w = shapeWeights(ids, st.active, shape);
      const bins = await this.V.bins(pk, [...new Set([...burnIds, ...ids].map(chunkOf))]); let tx = 0n, ty = 0n; const adj = {};
      burnIds.forEach((id, k) => { const v = this.V.valueOf(bins.get(id), burnShares[k]); tx += v.x; ty += v.y; adj[id] = { x: v.x, y: v.y, s: burnShares[k] }; });
      const sw = sideWeights(ids, w.weightsX, w.weightsY, st.active); const minShares = await this.minSharesFor(pk, ids, distribute(tx, sw.weightsX), distribute(ty, sw.weightsY), 300, adj); this.log('Your wallet signs');
      const r = this.chain.rebalance(this.chain.pool(pos.pool), this.pk, new PublicKey(pos.owner), burnIds, burnShares, ids, w.weightsX, w.weightsY, minShares);
      Object.assign(pos, { ids, lo, hi, shape }); this.store.save();
      const t = this.chain.tx('rebalance_position', [], this._pub('rebalance', [['Rebalance', burnIds.length + ' bins out, ' + ids.length + ' bins in (' + lo + ' … ' + hi + ', ' + shape + ')'], ['Back to the wallet', fmtA(this.chain, pos.x, r.burned.x - r.readded.x) + ' + ' + fmtA(this.chain, pos.y, r.burned.y - r.readded.y)]])); this.lastTx = t; return { tx: t }; }
    async rebalanceLimit(pos) { return pos.kind === 'shielded' ? Z.K : 41; }
    async placeOrder(pool, o) { if (o.priv) return super.placeOrder(pool, o); const { isAsk, binId, amount } = o; const addr = pool.address; const sym = isAsk ? pool.x : pool.y; const st = await this.poolState(addr, 1);
      if (isAsk && binId <= st.active) throw new Error('A sell order sits above the current price. Raise the price.'); if (!isAsk && binId >= st.active) throw new Error('A buy order sits below the current price. Lower the price.');
      const owner = Keypair.generate().publicKey; const v = this.unit(sym, amount); this.log('Your wallet signs'); this.chain.placeOrder(this.chain.pool(addr), this.pk, owner, this.pk, binId, !!isAsk, v);
      const tx = this.chain.tx('place_limit_order', [], this._pub('order', [['Limit order', (isAsk ? 'sell ' : 'buy ') + pool.x + ' in bin ' + binId + ' at ' + this.humanPrice(st, binId).toPrecision(6) + ' ' + pool.y], ['Amount', fmtA(this.chain, sym, v)]])); this.lastTx = tx;
      const ord = { id: 'o' + Date.now(), kind: 'public', owner: owner.toBase58(), authority: this.account, amount: String(v), pool: addr, x: pool.x, y: pool.y, binId, isAsk: !!isAsk, sym, createdAt: Date.now(), tx }; this.store.data.orders.push(ord); this.store.save(); return ord; }
    async withdrawOrder(o, opt) { if (o.kind !== 'public') return super.withdrawOrder(o, opt); const cur = await this.orderInfo(o); if (!cur || cur.shares === 0n) throw new Error('Nothing left in this order.');
      this.log('Your wallet signs'); const r = this.chain.withdrawOrder(this.chain.pool(o.pool), this.pk, new PublicKey(o.owner), o.binId, !!o.isAsk, cur.shares); o.closed = Date.now(); this.store.save();
      const tx = this.chain.tx('withdraw_limit_order', [], this._pub('order', [['Order withdrawn', fmtA(this.chain, o.x, r.x) + ' + ' + fmtA(this.chain, o.y, r.y) + ' to the wallet']])); this.lastTx = tx; return { tx, x: r.x, y: r.y, filled: cur.filled }; }
    /// Push the price: a bot trade of `human` units of the token sold (tests, and the "move the price" control).
    nudge(addr, xForY, human) { const P = this.chain.pool(addr); const sym = xForY ? P.x : P.y; const amt = this.unit(sym, human); const bot = keyFrom('bot:nudge'); this.chain.credit(bot, sym, amt);
      const r = this.chain.swapRoute(bot, sym, xForY ? P.y : P.x, [{ pool: P.address, xForY }], amt, 0n); this.chain.tx('swap', [], { pub: [['Swap by a bot', fmtA(this.chain, sym, amt) + ' → ' + fmtA(this.chain, xForY ? P.y : P.x, r.out)]], hidden: [] }); return P.p.activeId; }
    /// Close the current batch now (tests; the app waits for the epoch).
    closeSoon(addr) { const s = this.chain.sealed.get(b58(addr)); const b = s && s.batches.get(s.seq); if (b && b.state === 'open') b.endSlot = this.chain.slot(); }
  }
  return Sandbox;
}
