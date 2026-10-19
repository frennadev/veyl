// Phase 2 for the browser engine: the shielded pool. Installed onto the Engine class by sol-entry.js.
//
// Keys: one 32-byte seed per browser (random on first use; it travels only inside the encrypted backup). From it: the
// spending key (owner of every note), the X25519 viewing key (decrypts the notes addressed to it) and one-time keys for
// receipts. Notes are never stored as the source of truth: they are rebuilt by scanning the shielded tree's events with
// these keys (the relayer serves them; the engine checks the leaves against the on-chain root first).
// Proofs are made in a Web Worker (site/prove-worker.js) so the page stays responsive; the time of each is recorded.
// Every action below spends shielded notes; the relayer submits. Amounts inside the pool never appear on chain; what
// meets a pool (a swap's input and output, a position's change per bin, an order's size) is public, as is anything that
// enters or leaves the shielded pool.
import { Buffer } from 'buffer';
import { PublicKey, Keypair } from '@solana/web3.js';
const S = require('../sdk/veyl.js');
const Z = require('../sdk/shield.js');
const { chunkOf, distribute, shapeWeights, sideWeights, priceOf, simulateSwap, chunksForSwap, EMPTY_BIN } = S;
const b58 = (k) => new PublicKey(k).toBase58();
const B64 = (u) => Buffer.from(u).toString('base64');
const K = Z.K;

export function installShield(Engine, PrivacyError) {
  const P = Engine.prototype;

  // ---------------------------------------------------------------------------------------------- keys, scanning
  P.shieldInit = function () {
    const st = this.store.data;
    if (!st.shield || typeof st.shield !== 'object') st.shield = {};
    const sh = st.shield; for (const k of ['orders', 'pending', 'meta']) if (!sh[k]) sh[k] = k === 'meta' ? {} : [];
    if (!sh.seed) { const b = new Uint8Array(32); globalThis.crypto.getRandomValues(b); sh.seed = B64(b); sh.createdAt = Date.now(); this.store.save(); }
    const mints = {}; for (const [sym, t] of Object.entries(this.tokens)) mints[t.mint] = { sym, decimals: t.decimals };
    const pools = (this.cfg.binPools || []).map((b) => ({ address: b.address, mintX: this.tokens[b.x].mint, mintY: this.tokens[b.y].mint, x: b.x, y: b.y }));
    this.zw = new Z.ShieldWallet(Buffer.from(sh.seed, 'base64'), { mints, pools }); this.zw.ot = sh.ot || 0; this.zw.orderBook = sh.orders;
    this.proveMs = this.proveMs || { transact: [], position: [], swap: [], claim: [] };
    return this.zw;
  };
  /// This account's Veyl address: the spending public key and the X25519 viewing key. Share it to be paid privately.
  P.veylAddress = function () { return (this.zw || this.shieldInit()).address; };
  /// Rebuild every shielded note from the chain's events. The tree state is cached in this browser (memory + localStorage)
  /// and read incrementally: only signatures newer than the cached one. Every source is checked against the on-chain root
  /// history, in order: the cache + new signatures, the relayer's copy, a full read from the chain.
  P.shieldSync = async function () {
    const zw = this.zw || this.shieldInit(); let got = null;
    // Right after this browser submitted an action, the history (RPC signature index, the relayer's copy) can lag the chain by a
    // few seconds, and an older root is still a known one: wait briefly for the tree whose root is the current one, so the
    // action's own notes (a new position, a change note) are in it. Otherwise any known root will do.
    const fresh = this._syncFresh; this._syncFresh = false;
    for (let attempt = 0; ; attempt++) {
      const onchain = await this.V.shield(); if (!onchain) throw new Error('The shielded pool is not deployed on this network.');
      got = await this._readShieldState(onchain);
      if (!fresh || got.rootOk === false || BigInt(got.tree.root()) === BigInt(onchain.currentRoot) || attempt >= 8) break;
      await new Promise((res) => setTimeout(res, 1500));
    }
    this.shieldTreeOk = got.rootOk !== false; if (this.shieldTreeOk) this._shieldCacheSave(got); else { this._shMem = null; this.log('The shielded history read from the chain does not match its root' + ((got.r.truncated || []).length ? ' (cut logs in ' + got.r.truncated.join(', ') + ')' : '')); }
    const r = got.r; const st = { tree: got.tree, leaves: got.tree.leaves, ciphertexts: r.ciphertexts, receipts: r.receipts instanceof Map ? [...r.receipts.values()] : r.receipts, nullified: r.nullified, pending: r.pending, deposits: r.deposits || {}, newest: r.newest || null };
    const sh = this.store.data.shield; zw.scan(st, sh.outbox || []); this.shieldState = st; sh.ot = zw.ot; if (zw.notes.length) sh.used = true; this._outboxPrune(st);
    // deposits still waiting for the approved-set publisher (the chain lists them by depositor)
    const pend = (st.pending || []).map((p) => ({ pending: String(p.pending), depositor: String(p.depositor), mint: String(p.mint), amount: String(p.amount), commitments: (p.commitments || []).map(String) }));
    sh.pending = (sh.pending || []).filter((p) => pend.some((q) => q.commitments.includes(String(p.commitment))));
    this.shieldPendingNow = pend.filter((p) => this.account && p.depositor === this.account);
    this.store.save(); return zw.notes;
  };
  const CACHE_V = 1; const cacheKey = (e) => 'veyl:shieldcache:' + e.cfg.programs.entry + ':' + (e.cfg.programs.pool || '');
  /// { r: readShield-shaped state, tree, via: 'cache' | 'relayer' | 'chain' } whose root the chain knows.
  P._readShieldState = async function (onchain) {
    const known = (tree, n) => onchain.isKnownRoot(tree.root()) || (n === 0 && onchain.nextIndex === 0n);
    const mem = this._shieldCacheLoad();
    if (mem) { try { const r = await this.V.readShield({ prev: mem.r }); const tree = Z.Tree.grow(mem.tree, r.leaves); if (known(tree, r.leaves.length)) return { r, tree, via: 'cache' }; } catch { /* inconsistent: read again below */ }
      this._shMem = null; }
    try { const r = await fetch(this.cfg.relayer + '/shield').then((x) => x.json()); if (r.error) throw new Error(r.error); const tree = new Z.Tree(r.leaves.map(BigInt)); if (known(tree, r.leaves.length)) return { r, tree, via: 'relayer' }; } catch { /* the relayer is down or disagrees with the chain */ }
    // the last resort is used even when its root is unknown (the balance still shows), but not cached: a transaction whose
    // logs Solana cut can hide a tree leaf from every reader (r.truncated lists them); proofs against this tree will fail
    const r = await this.V.readShield(); const tree = new Z.Tree(r.leaves); return { r, tree, via: 'chain', rootOk: known(tree, r.leaves.length) };
  };
  P._shieldCacheLoad = function () { if (this._shMem) return this._shMem;
    try { const c = JSON.parse(localStorage.getItem(cacheKey(this)) || 'null'); if (c && c.v === CACHE_V && c.r && Array.isArray(c.r.leaves)) return (this._shMem = { r: c.r, tree: null, newest: c.r.newest }); } catch { /* storage blocked or corrupt */ }
    return null; };
  /// Keep the state for the next sync; written to localStorage only when it moved (a full or blocked storage keeps it in memory).
  P._shieldCacheSave = function (got) { const prevNewest = this._shMem && this._shMem.newest; this._shMem = { r: got.r, tree: got.tree, newest: got.r.newest || null };
    if (!got.r.newest || (got.via === 'cache' && prevNewest === got.r.newest)) return;
    try { localStorage.setItem(cacheKey(this), JSON.stringify({ v: CACHE_V, r: Z.serializeShield(got.r) })); } catch { /* memory only */ } };
  /// Forget the cached tree (the next sync reads it in full).
  P.shieldCacheClear = function () { this._shMem = null; try { localStorage.removeItem(cacheKey(this)); } catch { /* nothing stored */ } };

  // ---------------------------------------------------------------------------------------------- outbox
  // Every note an action creates for this account reaches it as an encrypted event in the transaction's logs, and Solana
  // drops logs past ~10 KB without a trace. So before anything is sent, the notes the request creates for this account
  // (whatever its ciphertexts open to with this viewing key: change notes, a position note and its fee notes, sealed swap
  // and claim notes) go into store.data.shield.outbox (it travels in the encrypted backup). A sync adopts an entry whose
  // commitment is in the tree when no ciphertext delivered it, and drops entries found through a ciphertext or that can
  // no longer land.
  const OUTBOX_FAILED = 30 * 60_000, OUTBOX_TTL = 14 * 86_400_000; // an action the relayer refused; anything not seen for two weeks
  P._outboxAdd = function (req) { if (!this.zw || !req || !req.kind) return []; const cts = [], nf = [];
    const ext = (e) => { if (e) for (const k of ['encOut', 'encChange', 'encSwap']) { const v = e[k]; if (v !== undefined && v !== null) (Array.isArray(v) ? v : [v]).forEach((x) => cts.push(x)); } };
    const pubs = (p, ids) => { if (p && p.pubs) for (const i of ids) if (p.pubs[i] !== undefined) nf.push(String(p.pubs[i])); };
    ext(req.ext); if (req.leg) ext(req.leg.ext); for (const l of req.legs || []) ext(l.ext); if (req.core && req.core.ciphertext) cts.push(req.core.ciphertext);
    if (req.kind === 'sealedSwap') pubs(req.p, [1, 2]); else if (req.kind === 'sealedClaim') pubs(req.p, [1]);
    else { pubs(req.p, [4, 5]); if (req.leg) pubs(req.leg.p, [4, 5]); for (const l of req.legs || []) pubs(l.p, [4, 5]); pubs(req.position, [1]); }
    let add = []; try { add = this.zw.outboxOf(cts, nf); } catch { /* not a request with notes */ } if (!add.length) return [];
    for (const o of add) o.kind = req.kind; const sh = this.store.data.shield; sh.outbox = [...(sh.outbox || []).filter((o) => !add.some((x) => x.c === o.c)), ...add]; this.store.save(); return add; };
  P._outboxPrune = function (st) { const sh = this.store.data.shield; const ob = sh.outbox; if (!ob || !ob.length) return; const zw = this.zw; const now = Date.now();
    const spent = st.nullified instanceof Set ? st.nullified : new Set((st.nullified || []).map(String));
    sh.outbox = ob.filter((o) => {
      if (zw.found.has(o.c)) return false; // its ciphertext is in the history: every scan finds it without help
      if (zw.leafIndex.has(o.c)) return zw.notes.some((n) => n.outbox === o.c && !n.spent && Z.worth(n)); // adopted: the only record of these notes, kept while one is unspent
      if ((o.nf || []).some((x) => spent.has(String(x)))) return false; // its inputs were spent by another action: this one can never land
      return now - o.at < (o.err ? OUTBOX_FAILED : OUTBOX_TTL); });
    if (sh.outbox.length !== ob.length) this.store.save(); };
  /// Planned notes not seen on chain yet, and the ones only the outbox knows about (adopted): for a status line or support.
  P.outboxState = function () { const zw = this.zw || this.shieldInit(); return (this.store.data.shield.outbox || []).map((o) => ({ commitment: o.c, kind: o.kind || null, at: o.at, tx: o.tx || null, failed: !!o.err, adopted: !!(zw.leafIndex && zw.leafIndex.has(o.c)) })); };
  // every relayed action goes through submit(): its notes are in the outbox before the request leaves this page
  const submit0 = P.submit;
  P.submit = async function (req) { const ob = this._outboxAdd(req); let r;
    try { r = await submit0.call(this, req); } catch (e) { const t = Date.now(); for (const o of ob) o.err = t; if (ob.length) this.store.save(); throw e; }
    for (const o of ob) o.tx = r.txHash; if (ob.length) this.store.save(); return r; };

  P.shieldBalance = function (sym) { return (this.zw || this.shieldInit()).balance(this.tok(sym).mint); };
  P.shieldNotes = function () { return (this.zw || this.shieldInit()).notes.filter((n) => !n.spent && BigInt(n.amount || 0) > 0n && n.kind === Z.NOTE.TOKEN); };

  // ---------------------------------------------------------------------------------------------- proving (Web Worker)
  P.proveIn = async function (circuit, input) {
    const zk = this.cfg.zk && this.cfg.zk[circuit]; if (!zk) throw new Error('This site has no ' + circuit + ' circuit configured.');
    this.log('Generating the proof on your device'); const t0 = Date.now(); let out;
    if (typeof Worker !== 'undefined' && this.cfg.worker !== false) {
      if (!this._worker) { try { this._worker = new Worker(this.cfg.proverWorker || 'prove-worker.js'); this._wq = new Map(); this._wid = 0; this._worker.onmessage = (e) => { if (e.data.progress) return; /* download / proving progress (the Sandbox shows it) */ const q = this._wq.get(e.data.id); if (q) { this._wq.delete(e.data.id); e.data.error ? q.rej(new Error(e.data.error)) : q.res(e.data); } }; } catch { this._worker = null; } }
      if (this._worker) { const id = ++this._wid; out = await new Promise((res, rej) => { this._wq.set(id, { res, rej }); this._worker.postMessage({ id, input, wasm: new URL(zk.wasm, location.href).href, zkey: new URL(zk.zkey, location.href).href }); }); }
    }
    if (!out) { if (!window.snarkjs) throw new Error('snarkjs is not loaded'); out = await window.snarkjs.groth16.fullProve(input, zk.wasm, zk.zkey); }
    const ms = Date.now() - t0; this.proveMs[circuit].push(ms); this.lastProof = { circuit, ms, worker: !!this._worker };
    const p = Z.packProofN(out.proof, out.publicSignals, circuit === 'claim' ? 6 : 8); while (p.pubs.length < 8) p.pubs.push(0n); // claim: 6 signals, stored with two zeros
    return { proof: B64(p.proof), pubs: p.pubs.map(String), ms };
  };

  // ---------------------------------------------------------------------------------------------- relayer
  P.shieldFee = async function (kind, sym, extra = {}) { const r = await fetch(this.cfg.relayer + '/fee', { method: 'POST', headers: { 'content-type': 'application/json' }, body: S.j({ kind, mint: this.tok(sym).mint, ...extra }) }).then((x) => x.json());
    if (r.error) throw new Error(r.error.charAt(0).toUpperCase() + r.error.slice(1) + '.'); return BigInt(r.fee); };
  P._relayerAddr = async function () { if (!this._rinfo) this._rinfo = await this.relayerInfo(); return new PublicKey(this._rinfo.address); };
  /// Make sure at most two notes cover `need` of `sym`, merging (a private transfer to yourself) while they do not.
  P.ensureSpendable = async function (sym, need) {
    const zw = this.zw; const mint = this.tok(sym).mint; need = BigInt(need);
    for (let i = 0; i < 6 && !zw.select(mint, need); i++) {
      if (zw.balance(mint) < need) throw new Error('Not enough ' + sym + ' in your shielded balance.');
      this.log('Merging two notes first'); const fee = await this.shieldFee('transact', sym); const two = zw.mergePlan(mint); const me = await this._relayerAddr();
      const total = two.reduce((s, n) => s + BigInt(n.amount), 0n); if (total <= fee) throw new Error('Your ' + sym + ' notes are too small to merge.');
      const t = zw.transact({ mint, ins: two, outs: [{ amount: total - fee }], ext: { fee, relayer: this.V.ata(new PublicKey(mint), me, await this.V.tokenProgram(new PublicKey(mint))), mint: new PublicKey(mint) } });
      const p = await this.proveIn('transact', t.input); await this.submit({ kind: 'transact', ext: t.ext, p }); await this.shieldSync();
      need = need; // a merge cost a fee: re-check against what is left
      if (zw.balance(mint) < need) throw new Error('Not enough ' + sym + ' left after merging to cover the relayer\'s fees.'); }
    return true;
  };
  P._entryLeg = async function (sym, amount, fee, action) { const mint = new PublicKey(this.tok(sym).mint); const tp = await this.V.tokenProgram(mint); const me = await this._relayerAddr();
    await this.ensureSpendable(sym, BigInt(amount) + BigInt(fee));
    const t = this.zw.spend({ mint, pay: BigInt(amount), fee: BigInt(fee), recipient: this.V.ata(mint, this.V.signerPda(), tp), relayer: this.V.ata(mint, me, tp), processor: this.V.signerPda(), action });
    return { ext: t.ext, p: await this.proveIn('transact', t.input) }; };

  // ---------------------------------------------------------------------------------------------- deposits, sends, withdrawals
  /// Public tokens -> the shielded pool. The wallet signs two transactions (the proof, then the deposit); the notes wait
  /// for the approved-set publisher, and until then the deposit can be taken back (cancelDeposit).
  P.shieldDeposit = async function (sym, amount) {
    if (!this.pk) throw new Error('Connect a wallet first.'); const zw = this.zw || this.shieldInit(); await this.shieldSync();
    const v = this.unit(sym, amount); const mint = new PublicKey(this.tok(sym).mint); const wrap = await this.wrapIxs(mint, v); const d = zw.deposit(mint, v);
    const p = await this.proveIn('transact', d.input); const pubs = p.pubs.map(BigInt);
    const ixPost = this.V.postProofIx(this.pk, Z.KIND.TRANSACT, Buffer.from(p.proof, 'base64'), pubs); const ixDep = await this.V.shieldDepositIx(this.pk, d.ext, pubs);
    const ob = this._outboxAdd({ kind: 'deposit', ext: d.ext, p }); let tx; // the deposit's note, kept before the wallet signs (see outbox)
    try { tx = await this._sendAll(wrap.length ? [wrap, [ixPost], [ixDep]] : [[ixPost], [ixDep]], 1_400_000); } catch (e) { for (const o of ob) o.err = Date.now(); this.store.save(); throw e; }
    for (const o of ob) o.tx = tx;
    this.store.data.shield.pending.push({ commitment: String(d.commitments[0]), sym, amount: String(v), tx, at: Date.now() }); this.store.save();
    return { tx, value: v };
  };
  P.cancelDeposit = async function (pending) { if (!this.pk) throw new Error('Connect the wallet you deposited from.');
    return this._sendAll([[await this.V.cancelDepositIx(this.pk, new PublicKey(pending.pending), new PublicKey(pending.mint))]], 200_000); };
  /// Shielded -> another Veyl address, inside the pool. Public: two nullifiers, two new notes, the relayer's flat fee and so
  /// its token. Hidden: the amount, the sender, the recipient.
  P.send = async function (sym, amount, to) {
    let dest; try { dest = Z.decodeAddress(to); } catch (e) { throw new PrivacyError(e.message); }
    if (to === this.veylAddress()) throw new PrivacyError('That is your own Veyl address.');
    await this.shieldSync(); const v = this.unit(sym, amount); const fee = await this.shieldFee('transact', sym); await this.ensureSpendable(sym, v + fee);
    const mint = new PublicKey(this.tok(sym).mint); const me = await this._relayerAddr();
    const t = this.zw.spend({ mint, send: v, to, fee, relayer: this.V.ata(mint, me, await this.V.tokenProgram(mint)) });
    const p = await this.proveIn('transact', t.input); const r = await this.submit({ kind: 'transact', ext: t.ext, p }); await this.shieldSync();
    return { tx: r.txHash, sent: v, fee };
  };
  /// Shielded -> a Solana address (leaves the pool: amount and recipient public).
  P.shieldWithdraw = async function (sym, amount, to, { allowUsed = false } = {}) {
    if (!allowUsed) await this.guardRecipient(to);
    await this.shieldSync(); const v = this.unit(sym, amount); const mint = new PublicKey(this.tok(sym).mint); const tp = await this.V.tokenProgram(mint);
    const recipient = this.V.ata(mint, new PublicKey(to), tp); const fee = await this.shieldFee('transact', sym, { recipientOwner: to, ext: { extAmount: '-1', recipient: recipient.toBase58() } });
    await this.ensureSpendable(sym, v + fee); const me = await this._relayerAddr();
    const t = this.zw.spend({ mint, pay: v, fee, recipient, relayer: this.V.ata(mint, me, tp) });
    const p = await this.proveIn('transact', t.input); const r = await this.submit({ kind: 'transact', ext: t.ext, p, recipientOwner: to }); await this.shieldSync();
    return { tx: r.txHash, received: v, fee };
  };
  /// A legacy note (Phase 1 pool) -> one receipt note in the shielded pool (one legacy proof; the amount was already public).
  P.migrate = async function (note) {
    await this.shieldSync(); const info = await this.relayerInfo(); const ot = this.zw.nextOneTime(); this.store.data.shield.ot = this.zw.ot; this.store.save();
    const d = { owner: ot.pk, blinding: ot.blinding, feeRecipient: info.address, feeBps: info.minFeeBps, deadline: this.deadline() };
    d.feeBps = await this.feeFor({ kind: 'relay', mint: this.tok(note.sym).mint, value: BigInt(note.value), d: { recipient: info.address } });
    const s = await this.state(note.pool); if (!s.labels.map(String).includes(String(note.label))) throw new PrivacyError('This deposit is not approved yet. It can still be taken back publicly (ragequit).');
    const ctx = S.contextOf(this.V.signerPda(), Buffer.concat([Buffer.from([Z.MIGRATE]), Z.encodeMigrate(d)]), new PublicKey(note.pool));
    const w = S.withdrawInput({ note, withdrawnValue: BigInt(note.value), context: ctx, leaves: s.leaves, labels: s.labels });
    this.log('Generating the proof on your device'); const { proof, publicSignals } = await window.snarkjs.groth16.fullProve(w.input, this.cfg.zk.wasm, this.cfg.zk.zkey); const pk_ = S.packProof(proof, publicSignals);
    const r = await this.submit({ kind: 'migrate', mint: this.tok(note.sym).mint, d, p: { proof: pk_.proof.toString('base64'), pubs: pk_.pubs.map(String) } });
    note.spent = true; note.migrated = r.txHash; this.store.save(); await this.shieldSync(); return { tx: r.txHash };
  };

  // ---------------------------------------------------------------------------------------------- swaps
  P.shieldSwap = async function (symIn, symOut, amountIn, { slippageBps = 100 } = {}) {
    await this.shieldSync(); const v = this.unit(symIn, amountIn); const fee = await this.shieldFee('shieldSwap', symIn);
    const best = await this.quoteRoute(symIn, symOut, v); if (!best) throw new Error('No route with liquidity for that pair.');
    const ot = this.zw.nextOneTime(); this.store.data.shield.ot = this.zw.ot; this.store.save();
    const routes = await this.V.prepareRoutes([{ amountIn: v, hops: best.path.map((h) => ({ pool: h.pool, xForY: h.xForY })) }]);
    const core = { tokenOut: new PublicKey(this.tok(symOut).mint), routes, minOut: best.out - (best.out * BigInt(slippageBps)) / 10000n, receiptOwner: ot.pk, receiptBlinding: ot.blinding, deadline: this.deadline() };
    const leg = await this._entryLeg(symIn, v, fee, Z.swapAction(core));
    const r = await this.submit({ kind: 'shieldSwap', core, leg }); await this.shieldSync();
    const ev = (await this.V.events(r.txHash)).find((e) => e.name === 'ShieldSwapped');
    return { tx: r.txHash, out: ev ? ev.amountOut : best.out, route: best.path.map((h) => h.name) };
  };

  // ---------------------------------------------------------------------------------------------- liquidity
  /// The shielded position(s) as the app's position objects (window of 16 bins from `lo`).
  P.shieldPositions = function () { const zw = this.zw || this.shieldInit(); const meta = this.store.data.shield.meta || {};
    return zw.positions().map((n) => { const p = (this.cfg.binPools || []).find((b) => b.address === n.binPool) || {}; const key = n.binPool + ':' + n.lo; const m = meta[key] || {};
      const live = n.shares.map((s, i) => (s > 0n ? n.lo + i : null)).filter((x) => x !== null); const lo = live.length ? Math.min(...live) : n.lo, hi = live.length ? Math.max(...live) : n.lo + K - 1;
      return { id: 'z:' + key, kind: 'shielded', pool: n.binPool, x: p.x, y: p.y, lo, hi, windowLo: n.lo, ids: live.length ? live : [n.lo], shape: m.shape || 'spot', createdAt: m.at || 0, note: n }; }); };
  /// What a shielded position holds now: value per token, fees it can claim (at the current fee growth H, plus an estimate
  /// of what the next harvest adds), range status.
  P.shieldPositionInfo = async function (pos) { const pool = new PublicKey(pos.pool); const bp = await this.V.binPool(pool); const n = pos.note; const win = []; for (let b = 0; b < K; b++) win.push(n.lo + b);
    const bins = await this.V.bins(pool, [...new Set(win.map(chunkOf))]); const g = await this.V.growthOf(pool, n.lo); const agg = await this.V.aggregateOf(pool, n.lo);
    const sa = {}; for (const c of [...new Set(win.map(chunkOf))]) sa[c] = await this.V.shareAccount(pool, this.V.shieldOwner(), this.V.signerPda(), c);
    const value = { x: 0n, y: 0n }; let ex = 0n, ey = 0n;
    win.forEach((id, b) => { const s = n.shares[b]; if (s === 0n) return; const bin = bins.get(id) || EMPTY_BIN; const v = Z.valueOfShares(bin, s); value.x += v.x; value.y += v.y;
      const slot = sa[chunkOf(id)] && sa[chunkOf(id)].slots[S.slotOf(id)]; if (bin && slot && agg[b] > 0n) { ex += (S.owedOf(bin.feeGx, slot.feeCpX, agg[b]) * s) / agg[b]; ey += (S.owedOf(bin.feeGy, slot.feeCpY, agg[b]) * s) / agg[b]; } });
    const cl = Z.claimable(n.shares, n.debt, g);
    return { bins: [], value, fees: { x: cl[0].q + ex, y: cl[1].q + ey }, claimable: { x: cl[0].q, y: cl[1].q }, rewards: [0n, 0n], shares: n.shares, active: bp.activeId, inRange: bp.activeId >= pos.lo && bp.activeId <= pos.hi, open: n.shares.some((s) => s > 0n), shielded: true }; };
  /// The core of every shielded liquidity action: given the window, signed share changes, funding legs and fees, make the
  /// position proof and the legs' proofs, then submit. Returns the relayer's answer and the event.
  P._lp = async function (pool, lo, deltas, { legs = [], claimFee = [0n, 0n], leftoverFee = [0n, 0n], maxCharge = [0n, 0n], zap = null, hint = null } = {}) {
    const zw = this.zw; const poolPk = new PublicKey(pool.address || pool); const bp = await this.V.binPool(poolPk); const assets = [Z.assetOf(bp.mintX), Z.assetOf(bp.mintY)];
    const note = zw.position(poolPk, lo); const growth = await this.V.growthOf(poolPk, lo); const me = await this._relayerAddr();
    const plan = Z.nextPosition({ sk: zw.k.sk, binPool: poolPk, lo, note, delta: deltas, growth, assets, fee: claimFee });
    const ct = Z.seal(zw.k.viewPublic, Z.encodePosition({ ...plan, binPool: poolPk }));
    const o1 = zw.nextOneTime(), o2 = zw.nextOneTime(); this.store.data.shield.ot = zw.ot; this.store.save();
    const core = { binPool: poolPk, lo, deltas, hintX: hint ? hint.hintX : Array(K).fill(0n), hintY: hint ? hint.hintY : Array(K).fill(0n), zap, claimFee, leftoverFee, receiptOwner: [o1.pk, o2.pk], receiptBlinding: [o1.blinding, o2.blinding], maxCharge, relayer: me, deadline: this.deadline(), ciphertext: ct };
    const action = Z.lpAction(core); const legReqs = []; for (const l of legs) legReqs.push(await this._entryLeg(l.sym, l.amount, l.fee, action));
    await this.shieldSync(); const fresh = zw.position(poolPk, lo); // legs may have merged notes: re-read the position's index
    const pi = Z.positionInput({ tree: zw.tree, sk: zw.k.sk, binPool: poolPk, lo, note: fresh, delta: deltas, growth, assets, fee: claimFee, ext: core, outBlinding: plan.blinding });
    const pp = await this.proveIn('position', pi.input);
    const r = await this.submit({ kind: 'shieldLp', core, legs: legReqs, position: pp }); await this.shieldSync();
    const ev = (await this.V.events(r.txHash)).find((e) => e.name === 'ShieldLpExecuted'); return { r, ev, plan };
  };
  /// Amounts per window bin for a shape over [lo, hi] (the add panel's own rule), as 16-entry arrays.
  P._windowAmounts = function (st, wlo, lo, hi, shape, ax, ay) { const pl = this.plan(st, lo, hi, shape, ax, ay); const X = Array(K).fill(0n), Y = Array(K).fill(0n);
    pl.ids.forEach((id, i) => { X[id - wlo] = pl.xs[i]; Y[id - wlo] = pl.ys[i]; }); return { X, Y, ids: pl.ids }; };
  P.shieldAdd = async function (pool, o) {
    await this.shieldSync(); const addr = pool.address; const pk = new PublicKey(addr); const st = await this.poolState(addr, 1); const shape = o.shape === 'bidask' ? 'bidAsk' : o.shape || 'spot';
    const lo = o.lo !== undefined ? o.lo : st.active - o.range, hi = o.hi !== undefined ? o.hi : st.active + o.range; if (hi < lo) throw new Error('Pick a range.');
    if (hi - lo + 1 > K) throw new Error('A shielded position covers up to ' + K + ' bins. Narrow the range.');
    // an existing shielded position whose window covers the range takes the add; otherwise a new window starting at lo
    const existing = this.zw.positions().find((n) => n.binPool === b58(pk) && n.lo <= lo && n.lo + K - 1 >= hi); const wlo = existing ? existing.lo : lo;
    const ax = o.amountX > 0 ? this.unit(pool.x, o.amountX) : 0n, ay = o.amountY > 0 ? this.unit(pool.y, o.amountY) : 0n;
    // the reserve left for the price to move while the proofs are made (seconds on a laptop, longer on a phone); what the
    // bins do not need comes back as a receipt note, so a wider reserve costs nothing but a bigger change note
    // Each bin the price crosses while the proofs are made flips what its shares need from one token to the other, so
    // the reserve covers about three bins either way: 30,000 / bins basis points, between 3% and 60% (a 5-bin range keeps
    // 60% back, 11 bins 27%, 69 bins 4%). The part the bins do not take comes straight back as a receipt note.
    const slip = BigInt(o.slippageBps || Math.min(6000, Math.max(300, Math.floor(30000 / (hi - lo + 1))))); const cut = (v) => v - (v * slip) / 10000n;
    const w = this._windowAmounts(st, wlo, lo, hi, shape, cut(ax), cut(ay)); if (!w.ids.length) throw new Error(this._sideHint(st, lo, hi, ax, ay));
    const ids = []; for (let b = 0; b < K; b++) ids.push(wlo + b); const bins = await this.V.bins(pk, [...new Set([...ids.map(chunkOf), chunkOf(st.active)])]);
    const ex = Z.planExact(st.bp, bins, ids, w.X, w.Y); if (ex.shares.every((s) => s === 0n)) throw new Error('These amounts are too small for the bins they go to.');
    const lpq = { core: { binPool: b58(pk), lo: wlo } }; const syms = [...(ex.needX > 0n ? [[pool.x, ax]] : []), ...(ex.needY > 0n ? [[pool.y, ay]] : [])];
    // the first leg pays the relayer for the whole action (posting every proof + the LP instruction), the others for their own post
    const legs = []; for (const [i, [sym, amount]] of syms.entries()) legs.push({ sym, amount, fee: i === 0 ? await this.shieldFee('shieldLp', sym, { ...lpq, legs: syms.length }) : await this.shieldFee('transact', sym) });
    const { r } = await this._lp(pool, wlo, ex.shares, { legs, maxCharge: [ax / 100n + 1n, ay / 100n + 1n], hint: { hintX: ex.hintX, hintY: ex.hintY } });
    this.store.data.shield.meta[b58(pk) + ':' + wlo] = { shape: o.shape || 'spot', at: Date.now() }; this.store.save();
    return { id: 'z:' + b58(pk) + ':' + wlo, kind: 'shielded', pool: addr, x: pool.x, y: pool.y, ids: w.ids, lo, hi, shape, tx: r.txHash };
  };
  P.shieldRemove = async function (pos, pct) {
    await this.shieldSync(); const n = this.zw.position(pos.pool, pos.windowLo); if (!n) throw new Error('This position is not on this device any more.');
    const deltas = n.shares.map((s) => -((s * BigInt(pct)) / 100n)); if (deltas.every((d) => d === 0n)) throw new Error('Nothing left to withdraw in this position.');
    const fee = await this.shieldFee('shieldLp', pos.y, { core: { binPool: pos.pool, lo: n.lo }, legs: 0 });
    const { r, ev } = await this._lp(pos.pool, n.lo, deltas, { leftoverFee: [0n, fee] });
    return { tx: r.txHash, x: ev ? ev.receipts[0] : 0n, y: ev ? ev.receipts[1] : 0n };
  };
  P.shieldClaim = async function (pos) {
    await this.shieldSync(); const n = this.zw.position(pos.pool, pos.windowLo); const g = await this.V.growthOf(new PublicKey(pos.pool), n.lo); const cl = Z.claimable(n.shares, n.debt, g);
    const lq = { core: { binPool: pos.pool, lo: n.lo }, legs: 0 }; const fy = await this.shieldFee('shieldLp', pos.y, lq), fx = await this.shieldFee('shieldLp', pos.x, lq);
    const claimFee = cl[1].q > fy ? [0n, fy] : cl[0].q > fx ? [fx, 0n] : null; if (!claimFee) throw new Error('Fees collected so far are smaller than the relayer\'s cost to claim them. Fees earned since the last shielded action in these bins are collected by the next one; try again later.');
    const { r } = await this._lp(pos.pool, n.lo, Array(K).fill(0n), { claimFee });
    return { tx: r.txHash, x: cl[0].q - claimFee[0], y: cl[1].q - claimFee[1] };
  };
  /// Rebalance a shielded position: inside its 16-bin window, one proof burns the old bins and mints the new shape from the
  /// proceeds; a range outside the window is a removal into notes, then a new position from them (two private actions).
  P.shieldRebalance = async function (pos, { lo, hi, shape }) {
    await this.shieldSync(); const n = this.zw.position(pos.pool, pos.windowLo); const pk = new PublicKey(pos.pool); const st = await this.poolState(pos.pool, 1);
    const ids = []; for (let b = 0; b < K; b++) ids.push(n.lo + b); const bins = await this.V.bins(pk, [...new Set([...ids.map(chunkOf), chunkOf(st.active)])]);
    let vx = 0n, vy = 0n; const after = new Map(bins); ids.forEach((id, b) => { const s = n.shares[b]; if (s === 0n) return; const bin = bins.get(id); const v = Z.valueOfShares(bin, s); vx += v.x; vy += v.y; after.set(id, { ...bin, x: bin.x - v.x, y: bin.y - v.y, shares: bin.shares - s }); });
    if (lo >= n.lo && hi <= n.lo + K - 1) {
      const fee = await this.shieldFee('shieldLp', pos.y, { core: { binPool: pos.pool, lo: n.lo }, legs: 0 }); const w = this._windowAmounts(st, n.lo, lo, hi, shape, vx - vx / 30n, vy - vy / 30n - fee);
      const ex = Z.planExact(st.bp, after, ids, w.X, w.Y); const deltas = ids.map((_, b) => ex.shares[b] - n.shares[b]);
      const { r } = await this._lp(pos.pool, n.lo, deltas, { leftoverFee: [0n, fee], maxCharge: [vx / 100n + 1n, vy / 100n + 1n], hint: { hintX: ex.hintX, hintY: ex.hintY } });
      this.store.data.shield.meta[b58(pk) + ':' + n.lo] = { shape, at: Date.now() }; this.store.save(); return { tx: r.txHash };
    }
    this.log('Removal 1 of 2: back into notes'); await this.shieldRemove(pos, 100);
    const bx = this.shieldBalance(pos.x), by = this.shieldBalance(pos.y);
    this.log('Removal 2 of 2: the new range'); const pool = (this.cfg.binPools || []).find((b) => b.address === pos.pool);
    const add = await this.shieldAdd({ ...pool, x: pos.x, y: pos.y }, { lo, hi, shape, amountX: this.fmt(pos.x, vx < bx ? vx : bx), amountY: this.fmt(pos.y, vy < by ? vy : by) });
    return { tx: add.tx };
  };
  P.shieldZap = async function (pool, o) {
    await this.shieldSync(); const addr = pool.address; const pk = new PublicKey(addr); const st = await this.poolState(addr, 1); const shape = o.shape === 'bidask' ? 'bidAsk' : o.shape || 'spot';
    if (o.hi - o.lo + 1 > K) throw new Error('A shielded zap covers up to ' + K + ' bins. Narrow the range.');
    const sym = o.xIn ? pool.x : pool.y; const amt = this.unit(sym, o.amount); const ids = []; for (let i = o.lo; i <= o.hi; i++) ids.push(i); const w = shapeWeights(ids, st.active, shape);
    const pz = await this.V.planZap(pk, { xIn: !!o.xIn, amountIn: amt, ids, ...w, slippageBps: 200 });
    const bp = await this.V.binPool(pk); const swapBins = await this.V.bins(pk, chunksForSwap(bp, !!o.xIn)); const sim = pz.swapAmount > 0n ? simulateSwap(bp, swapBins, !!o.xIn, pz.swapAmount, Math.floor(Date.now() / 1000)) : { out: 0n, endId: bp.activeId, touched: [] };
    const win = []; for (let b = 0; b < K; b++) win.push(o.lo + b); const bins = await this.V.bins(pk, [...new Set([...win.map(chunkOf), chunkOf(sim.endId)])]); for (const t of sim.touched) bins.set(t.id, t);
    const sw = sideWeights(ids, w.weightsX, w.weightsY, sim.endId); const tx = o.xIn ? amt - pz.swapAmount : sim.out, ty = o.xIn ? sim.out : amt - pz.swapAmount;
    const ax = distribute(tx - tx / 20n, sw.weightsX), ay = distribute(ty - ty / 20n, sw.weightsY); const X = Array(K).fill(0n), Y = Array(K).fill(0n); ids.forEach((id, i) => { X[id - o.lo] = ax[i]; Y[id - o.lo] = ay[i]; });
    const ex = Z.planExact({ ...bp, activeId: sim.endId }, bins, win, X, Y); if (ex.shares.every((s) => s === 0n)) throw new Error('Too small to zap into these bins.');
    const { r } = await this._lp(pool, o.lo, ex.shares, { legs: [{ sym, amount: amt, fee: await this.shieldFee('shieldLp', sym, { core: { binPool: addr, lo: o.lo }, legs: 1 }) }], zap: pz.swapAmount > 0n ? { xIn: !!o.xIn, amount: pz.swapAmount, minOut: sim.out - sim.out / 50n } : null, maxCharge: o.xIn ? [amt / 100n + 1n, sim.out / 50n + 1n] : [sim.out / 50n + 1n, amt / 100n + 1n], hint: { hintX: ex.hintX, hintY: ex.hintY } });
    this.store.data.shield.meta[b58(pk) + ':' + o.lo] = { shape: o.shape || 'spot', at: Date.now(), zap: true }; this.store.save();
    return { id: 'z:' + b58(pk) + ':' + o.lo, kind: 'shielded', pool: addr, x: pool.x, y: pool.y, ids, lo: o.lo, hi: o.hi, shape, tx: r.txHash };
  };

  // ---------------------------------------------------------------------------------------------- limit orders
  P.shieldPlaceOrder = async function (pool, { isAsk, binId, amount }) {
    await this.shieldSync(); const sym = isAsk ? pool.x : pool.y; const v = this.unit(sym, amount); const fee = await this.shieldFee('shieldOrder', sym);
    const ot = this.zw.nextOneTime(); const core = { binPool: new PublicKey(pool.address), id: binId, isAsk: !!isAsk, receiptOwner: ot.pk, receiptBlinding: ot.blinding, deadline: this.deadline() };
    const o = { id: 'zo' + Date.now(), kind: 'shielded', pool: pool.address, x: pool.x, y: pool.y, binId, isAsk: !!isAsk, sym, amount: String(v), createdAt: Date.now() };
    this.store.data.shield.orders.push(o); this.store.data.shield.ot = this.zw.ot; this.store.save();
    const leg = await this._entryLeg(sym, v, fee, Z.orderAction(core)); const r = await this.submit({ kind: 'shieldOrder', core, leg }); o.tx = r.txHash; this.store.save(); await this.shieldSync();
    return o;
  };
  P.shieldOrderInfo = async function (o) { const notes = this.zw.orderNotes(o.pool, o.binId, o.isAsk); const mine = notes.reduce((s, n) => s + BigInt(n.amount), 0n); if (mine === 0n) return { shares: 0n, unfilledX: 0n, filledY: 0n, unfilledY: 0n, filledX: 0n, filled: false };
    const b = (await this.V.bins(new PublicKey(o.pool), [chunkOf(o.binId)])).get(o.binId) || EMPTY_BIN; const sup = o.isAsk ? b.askShares : b.bidShares; const part = (v) => (sup ? (v * mine) / sup : 0n);
    return o.isAsk ? { shares: mine, unfilledX: part(b.askX), filledY: part(b.askFilledY), filled: part(b.askX) === 0n } : { shares: mine, unfilledY: part(b.bidY), filledX: part(b.bidFilledX), filled: part(b.bidY) === 0n }; };
  P.shieldWithdrawOrder = async function (o) {
    await this.shieldSync(); const notes = this.zw.orderNotes(o.pool, o.binId, o.isAsk); if (!notes.length) throw new Error('Nothing left in this order.');
    const me = await this._relayerAddr(); const fee = await this.shieldFee('shieldOrderWithdraw', o.isAsk ? o.y : o.x); const o1 = this.zw.nextOneTime(), o2 = this.zw.nextOneTime(); this.store.data.shield.ot = this.zw.ot; this.store.save();
    const core = { binPool: new PublicKey(o.pool), id: o.binId, isAsk: !!o.isAsk, leftoverFee: o.isAsk ? [0n, fee] : [fee, 0n], receiptOwner: [o1.pk, o2.pk], receiptBlinding: [o1.blinding, o2.blinding], relayer: me, deadline: this.deadline() };
    const t = this.zw.orderSpend({ binPool: o.pool, id: o.binId, isAsk: o.isAsk, notes: notes.slice(0, 2), processor: this.V.signerPda(), action: Z.orderWithdrawAction(core) });
    const p = await this.proveIn('transact', t.input); const r = await this.submit({ kind: 'shieldOrderWithdraw', core, leg: { ext: t.ext, p } }); await this.shieldSync();
    const ev = (await this.V.events(r.txHash)).find((e) => e.name === 'ShieldOrderWithdrawn'); if (!this.zw.orderNotes(o.pool, o.binId, o.isAsk).length) { o.closed = Date.now(); this.store.save(); }
    return { tx: r.txHash, x: ev ? ev.amountX : 0n, y: ev ? ev.amountY : 0n, filled: !!ev };
  };
  /// Encrypted backup content: the seed (every key derives from it), the one-time key counter, orders and display data.
  P.shieldExport = function () { const zw = this.zw || this.shieldInit(); return { seed: this.store.data.shield.seed, ot: zw.ot, address: zw.address }; };
}
