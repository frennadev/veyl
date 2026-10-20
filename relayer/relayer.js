// Veyl relayer for Solana. Submits proofs so the user's wallet never touches the transaction.
// It cannot steal or redirect anything (recipient, fee, route and deadline are hashed into the proof's context, and
// the pool program checks them), but it CAN see the request IP, so this server never logs IPs and only keeps a
// rate-limit counter in memory.
//
//   GET  /info                 relayer wallet, fee range, programs, lookup tables (the deployment's and poolLookupTables: this relayer's, for pools listed since)
//   GET  /state?pool=<pubkey>  the pool's leaves (tree order) and approved labels, for building proofs
//   GET  /pools                bin pools with their current state (quotes are computed on the device)
//   GET  /activity             every pool's totals over 1 h / 6 h / 24 h and its latest trades (no addresses)
//   GET  /candles?res=300|900|3600|14400|86400   every pool's OHLC candles (bin ids) at that resolution
//   POST /fee                  { kind, d, mint | legs, value }  -> { feeBps } that covers this relayer's cost for the request
//   POST /drip                 { to } devnet/local test tokens from the mock mints (FAUCET_KEY = the deployer, the mints' authority); never on mainnet
//   GET  /tokens?ids=<mints>       token metadata from Jupiter, through the relayer (sym:<SYMBOL> on devnet / local)
//   GET  /tokens/icon/<mint>     that token's logo: PNG / JPEG / WebP / GIF only, from public hosts, ≤256 KB
//   GET  /shield               Phase 2: the shielded tree (leaves in order), encrypted notes, receipts and pending deposits
//   POST /submit               { kind: relay | swap | add | remove | claim | reward | order | orderWithdraw | rebalance | zap, ... }
//                              Phase 2 (shielded pool): transact | shieldLp | shieldSwap | shieldOrder | shieldOrderWithdraw |
//                              migrate: proofs ({ proof, pubs } each) + the external data / request they commit to; the relayer
//                              posts every proof, uploads the request, and executes it. Fees are flat amounts inside the
//                              proofs (a percentage of a hidden amount would reveal it).
//                              -> { txs: [...signatures] }. Proof-bound kinds (relay, swap, add, order, zap) carry `p` (or
//                              legs[].p); kinds signed by a position's one-time key (remove, claim, reward, orderWithdraw,
//                              rebalance) carry `sig` (ed25519 over the action's digest). Same fee range and cost floor for all.
//
// Phase 3 (sealed batch swaps): POST /submit { kind: sealedSwap | sealedClaim, ... } executes a swap proof into the pool's
// current batch (or a claim / refund out of a finished one). A sealed request carries only ciphertexts and commitments: the
// relayer never learns an amount. GET /sealed?pool=<bin pool> is the pool's current batch (countdown, participants per
// direction, state, the last settled batch's public totals). It also cranks every sealed pool (close a batch whose epoch is
// over, fail one past its settlement window): anyone may, these are permissionless.
//
// It also runs the approved-set publisher ("postman") when POSTMAN_KEY is set: every 30 s it rebuilds the approved
// label tree from the chain's Deposited events, screens each deposit (relayer/denylist.json), and publishes the root; and
// for the shielded pool it admits each pending deposit whose depositor passes the same screening (approve_deposit).
//
// Layout: this file holds the core (wallet, deployment, /info, /health, /pools) and composes the parts below into one class;
// relayer/http.js serves it (Express). costs.js (request kinds and their worst-case cost), fees.js (the fee floor, /fee), notes.js
// (Phase 1 submissions, /state), shielded.js (Phase 2 + 3 submissions, /shield), sealed.js (/sealed, the batch crank),
// postman.js (approved-set publisher), faucet.js (/drip), luts.js (lookup tables for pools listed since the deploy), screening.js (denylist),
// env.js (keys and deployment from env).
'use strict';
const { Connection, PublicKey } = require('@solana/web3.js');
const S = require('../sdk/veyl.js'); const { Veyl } = S;
require('../sdk/shield.js'); require('../sdk/sealed.js'); // they add the shielded and sealed instructions to Veyl
const VERSION = require('../package.json').version;
const LOW_BALANCE_LAMPORTS = Number(process.env.LOW_BALANCE_SOL || 0.05) * 1e9;
const { WORST, SIGNED, SHIELD_KINDS, PROOF_LEGS, pricesFrom } = require('./costs.js');
const { isAllowed } = require('./screening.js');
const { serve, clientKey } = require('./http.js');
const { keyFromEnv, deployFromEnv } = require('./env.js');

class RelayerCore {
  constructor({ connection, wallet, deploy, minFeeBps = 5, maxFeeBps = S.MAX_FEE_BPS, postman = null, prices = null, feeCover = 1 }) {
    this.conn = connection; this.wallet = wallet; this.dep = deploy; this.minFeeBps = minFeeBps; this.maxFeeBps = maxFeeBps; this.postman = postman;
    this.prices = prices || pricesFrom(deploy); this.feeCover = feeCover;
    this.symOf = Object.fromEntries(Object.entries(deploy.tokens).map(([sym, t]) => [new PublicKey(t.mint).toBase58(), { sym, decimals: t.decimals }]));
    this.V = new Veyl({ connection, programs: deploy.programs, payer: wallet }); this.V.lookupTable = deploy.lookupTable ? new PublicKey(deploy.lookupTable) : null; this.V.lookupExtra = (deploy.lookupTables || []).map((t) => new PublicKey(t));
    this.pools = Object.values(deploy.tokens).map((t) => ({ mint: new PublicKey(t.mint), pool: new PublicKey(t.pool), decimals: t.decimals }));
    this.cache = new Map(); // pool -> { at, leaves, labels, deposits }
  }
  info() { return { faucet: !!this.faucet, address: this.wallet.publicKey.toBase58(), minFeeBps: this.minFeeBps, maxFeeBps: this.maxFeeBps, minFee: this.minFeeTable(), programs: this.dep.programs, lookupTable: this.dep.lookupTable, lookupTables: this.dep.lookupTables || [], poolLookupTables: (this.poolLuts || []).map((t) => t.toBase58()), entrySigner: this.V.signerPda().toBase58(), network: this.dep.network, postman: this.postman ? this.postman.publicKey.toBase58() : this.dep.postman, kinds: Object.keys(WORST), signedKinds: [...SIGNED] }; }
  /// Liveness for the host's health check: version, network, the hot wallet and its last known SOL balance (refreshed every
  /// minute in the background; it pays transaction fees and recipients' token-account rent, and never holds user funds).
  health() { return { ok: true, version: VERSION, network: this.dep.network, relayer: this.wallet.publicKey.toBase58(), balanceSol: this.balance === undefined ? null : this.balance / 1e9, lowBalance: this.balance !== undefined && this.balance < LOW_BALANCE_LAMPORTS, publisher: !!this.postman }; }
  async refreshBalance() { try { this.balance = await this.conn.getBalance(this.wallet.publicKey); if (this.balance < LOW_BALANCE_LAMPORTS) console.error('relayer balance low:', this.balance / 1e9, 'SOL'); } catch { /* RPC hiccup: keep the last value */ } }
  /// GET /pools: the deployment's pools and the ones listed on chain since (discover), each with its tier, status
  /// ('verified' | 'unverified' while its bond is locked | 'delisted') and the fixed protocol fee (bps of every swap's input).
  async binPools() { try { await this.discover(); } catch { /* the deployment's pools still list */ } const all = [...this.dep.binPools, ...(this.discovered || [])]; const out = [];
    const bonds = await this.V.bonds(all.map((b) => new PublicKey(b.address))); const now = Math.floor(Date.now() / 1000);
    for (const [i, b] of all.entries()) { const p = await this.V.binPool(b.address); if (!p) continue; const bond = bonds[i];
      out.push({ ...b, activeId: p.activeId, lowestId: p.lowestId, highestId: p.highestId, seeded: p.seeded, fee: (await this.V.currentFee(b.address)).toString(), price: S.priceOf(p.basePrice, p.binStep, p.activeId).toString(),
        protocolShare: 0, protocolFeeBps: p.protocolFeeBps, tier: { id: p.feeTier, feePips: p.baseFee, binStep: p.binStep, label: S.tierLabel(p.binStep, p.baseFee), category: S.tierCategory(p.binStep) },
        status: p.delisted ? 'delisted' : !b.discovered ? 'verified' : bond && now < Number(bond.unlockAt) ? 'unverified' : 'verified', creator: bond ? bond.creator.toBase58() : null,
        totalFeeX: p.totalFeeX.toString(), totalFeeY: p.totalFeeY.toString(), rewards: p.rewards.map((r, i) => (r.initialized ? { index: i, mint: r.mint.toBase58(), rateQ64: r.rate.toString(), end: Number(r.end) } : null)).filter(Boolean) }); } return out; }
  /// Pools anyone listed since the deploy (getProgramAccounts on veyl_bin, at most every 60 s; force: now). Their tokens are
  /// keyed by mint in symOf / extraTokens, so fees, the fee floor and routes work for them; fees in such a token follow
  /// _valueDiscovered and the limits in fees.js (_derivedLimit), else this relayer refuses them (an unpriced token would let
  /// anyone make it pay rent for nothing).
  /// A forced re-scan (a request named a mint this relayer does not know yet) runs at most every DISCOVER_MIN_MS (10 s): any
  /// request can name a made-up mint, and each scan reads every pool on chain (REVIEW.md L-7).
  async discover(force = false) { const age = this._discAt ? Date.now() - this._discAt : Infinity; if (age < (force ? Number(process.env.DISCOVER_MIN_MS || 10_000) : 60_000)) return this.discovered;
    if (this._discP) return this._discP; this._discP = (async () => { try {
      const known = new Set(this.dep.binPools.map((b) => b.address)); const chain = await this.V.binPools(); const fresh = chain.filter((p) => !known.has(p.address.toBase58()));
      this.extraTokens = this.extraTokens || {}; const out = [];
      for (const p of fresh) { for (const m of [p.mintX, p.mintY]) { const k = m.toBase58(); if (this.symOf[k]) continue; const mi = await this.V.mint(m); if (!mi) continue; await this.V.tokenProgram(m);
          this.extraTokens[k] = { mint: k, decimals: mi.decimals, program: mi.program }; this.symOf[k] = { sym: k, decimals: mi.decimals, discovered: true }; }
        const sx = this.symOf[p.mintX.toBase58()], sy = this.symOf[p.mintY.toBase58()]; if (!sx || !sy) continue;
        out.push({ id: [sx.sym, sy.sym].map((x) => (sx.discovered || sy.discovered ? x : x.toLowerCase())).join('-') + '-' + p.binStep, x: sx.sym, y: sy.sym, binStep: p.binStep, baseFee: p.baseFee, address: p.address.toBase58(), mintX: p.mintX.toBase58(), mintY: p.mintY.toBase58(), discovered: true }); }
      this.discovered = out; await this._valueDiscovered(fresh); this._discAt = Date.now(); this._chainPools = chain;
      if (chain.length) this.syncPoolLuts(chain).catch((e) => console.error('pool lookup tables', String(e.message).slice(0, 160))); /* in the background: /pools does not wait for it */
      return out; } finally { this._discP = null; } })(); return this._discP; }
  /// USD prices of discovered tokens (derivedPrices), for the fee floor only. A pool's spot price is whatever its creator
  /// opened it at, and its vault balance can sit at bins nowhere near that price, so neither is trusted: a token is valued
  /// from its pools against a priced (deployment) token by what selling it into the pool would actually return, counting
  /// only the priced side's liquidity within DISCOVERED_BAND (default 5%) of the active bin (at most 120 bins), as the
  /// average price of that band (never above spot). That band must hold at least DISCOVERED_MIN_DEPTH_USD (default 1000);
  /// the price is cut to DISCOVERED_HAIRCUT (default 0.5) and the lowest seen over the last DISCOVERED_TWAP_MS (30 min)
  /// is used, so a pump inside that window does not raise it. The deepest such pool wins.
  async _valueDiscovered(pools) { const env = process.env; const minUsd = Number(env.DISCOVERED_MIN_DEPTH_USD || 1000), cut = Number(env.DISCOVERED_HAIRCUT || 0.5), band = Number(env.DISCOVERED_BAND || 0.05), win = Number(env.DISCOVERED_TWAP_MS || 1_800_000); const best = {};
    for (const p of pools) { const kx = p.mintX.toBase58(), ky = p.mintY.toBase58(); const sx = this.symOf[kx], sy = this.symOf[ky]; if (!sx || !sy || p.delisted || !p.seeded) continue;
      const dec = (s) => (this.dep.tokens[s.sym] || this.extraTokens[s.sym]).decimals; const nb = Math.min(120, Math.max(1, Math.ceil(Math.log(1 + band) / Math.log(1 + p.binStep / 10_000))));
      for (const [mine, other, xIn] of [[sx, sy, true], [sy, sx, false]]) { if (!mine.discovered || other.discovered || !this.prices[other.sym]) continue;
        const q = await this._bandQuote(p, xIn, nb); if (!q) continue; const depth = (q.out / 10 ** dec(other)) * this.prices[other.sym]; if (depth < minUsd) continue;
        const px = q.rate * 10 ** (dec(mine) - dec(other)) * this.prices[other.sym] * cut; /* USD per whole token sold */
        if (px > 0 && (!best[mine.sym] || depth > best[mine.sym].depth)) best[mine.sym] = { px, depth }; } }
    const now = Date.now(); const hist = (this._pxHist = this._pxHist || {}); const out = {};
    for (const [k, v] of Object.entries(best)) { hist[k] = [...(hist[k] || []).filter((x) => now - x.at < win), { at: now, px: v.px }]; out[k] = Math.min(...hist[k].map((x) => x.px)); }
    for (const k of Object.keys(hist)) if (!best[k]) delete hist[k]; /* no deep pool now: unvalued, and its history starts again */
    this.derivedPrices = out; this.derivedDepth = Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.depth])); }
  /// Selling the pool's X (xIn) or Y into the `nb` bins from the active one: { out: the other token's atoms there, rate: out
  /// per atom sold (out / what buying all of it would take), never above the active bin's price }. null when empty.
  async _bandQuote(p, xIn, nb) { const a = p.activeId; const ids = []; for (let i = 0; i <= nb; i++) ids.push(xIn ? a - i : a + i);
    const bins = await this.V.bins(p.address, [...new Set(ids.map(S.chunkOf))]); let out = 0, cost = 0;
    for (const id of ids) { const b = bins.get(id); if (!b) continue; const px = Number(S.priceOf(p.basePrice, p.binStep, id)) / 2 ** 128; /* Y atoms per X atom */
      if (xIn) { const y = Number(b.y); if (y > 0 && px > 0) { out += y; cost += y / px; } } else { const x = Number(b.x); if (x > 0) { out += x; cost += x * px; } } }
    return out > 0 && cost > 0 ? { out, rate: out / cost } : null; }
  /// A discovered token this relayer cannot value for its fee floor.
  _unvalued(sym) { return !!(this.extraTokens && this.extraTokens[sym]) && !(this.derivedPrices && this.derivedPrices[sym] > 0); }
  /// The relayer's fee account for a discovered token, created when missing (its rent is in shieldCost).
  async _ensureFeeAccount(mint) { const k = new PublicKey(mint).toBase58(); if (!this.extraTokens || !this.extraTokens[k]) return; const tp = await this.V.tokenProgram(k); const ata = this.V.ata(k, this.wallet.publicKey, tp);
    if (await this.conn.getAccountInfo(ata)) return; const spl = require('@solana/spl-token'); await this.V.send([spl.createAssociatedTokenAccountIdempotentInstruction(this.wallet.publicKey, ata, this.wallet.publicKey, new PublicKey(k), tp)], [], 100_000); }
}
const Fees = require('./fees.js'), Notes = require('./notes.js'), Shielded = require('./shielded.js'), Sealed = require('./sealed.js'), Postman = require('./postman.js'), Faucet = require('./faucet.js'), Luts = require('./luts.js');
class Relayer extends Faucet(Postman(Sealed(Shielded(Notes(Fees(Luts(RelayerCore))))))) {
  /// A request naming a token this relayer has not seen (a pool listed in the last minute) looks again once, then retries.
  async _withDiscovery(f) { try { await this.discover(); } catch { /* the deployment's tokens still work */ } try { return await f(); } catch (e) { if (!/unknown token/.test(String(e && e.message))) throw e; await this.discover(true); return f(); } }
  async feeQuote(req) { return this._withDiscovery(() => super.feeQuote(req)); }
  /// A pool's accounts being added to a lookup table right now (syncPoolLuts) are waited for, a few seconds at most.
  async submit(req) { return this._withDiscovery(async () => { for (const m of feeMints(req)) await this._ensureFeeAccount(m); if (this._lutJob) await Promise.race([this._lutJob.catch(() => {}), new Promise((r) => setTimeout(r, 8000))]); return super.submit(req); }); }
}
/// The mints a request pays this relayer's fees in (legs, transact / sealed external data, an LP action's pool tokens).
function feeMints(req) { const out = new Set(); const add = (m) => { if (m && typeof m === 'string' && m.length >= 32) out.add(m); };
  add(req.mint); if (req.ext) add(req.ext.mint); if (req.leg && req.leg.ext) add(req.leg.ext.mint); for (const l of req.legs || []) { add(l.mint); if (l.ext) add(l.ext.mint); } return [...out]; }
module.exports = { Relayer, serve, isAllowed, clientKey, pricesFrom, WORST, SIGNED, PROOF_LEGS, SHIELD_KINDS, keyFromEnv, deployFromEnv };

if (require.main === module) {
  const env = process.env; const dep = deployFromEnv(env);
  // a dropped connection to the RPC (a connect timeout, a reset) is retried a few times: resending a signed transaction is safe
  const retryFetch = async (url, init) => { for (let i = 0; ; i++) { try { return await fetch(url, init); } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 500 * 2 ** i)); } } };
  const conn = new Connection(env.RPC_URL || dep.rpc, { commitment: 'confirmed', fetch: retryFetch });
  const wallet = keyFromEnv(env, 'RELAYER_SECRET_KEY', 'RELAYER_KEY'); if (!wallet) { console.error('Set RELAYER_SECRET_KEY (or RELAYER_KEY=<keypair file>): the relayer\'s own fee-only hot wallet.'); process.exit(1); }
  const postman = keyFromEnv(env, 'POSTMAN_SECRET_KEY', 'POSTMAN_KEY');
  const r = new Relayer({ connection: conn, wallet, deploy: dep, postman, minFeeBps: Number(env.MIN_FEE_BPS || 5), feeCover: Number(env.FEE_COVER || 1) });
  if (dep.network !== 'mainnet') r.faucet = keyFromEnv(env, 'FAUCET_SECRET_KEY', 'FAUCET_KEY');
  if (!r.prices.SOL) console.error('no SOL price (deploy file or PRICES_JSON): the fee floor is off and small requests can drain this wallet');
  if (dep.network === 'mainnet' && !env.ALLOWED_ORIGINS) console.error('ALLOWED_ORIGINS is not set: any website can call this relayer from its visitors\' browsers');
  if (env.RENDER && !Number(env.TRUST_PROXY)) console.error('TRUST_PROXY is not set behind Render: every client shares one rate limit (REVIEW.md L-2)');
  // a failed RPC call in a background job (a timeout, a dropped connection) is logged; it must not stop the relayer
  process.on('unhandledRejection', (e) => console.error('unhandled', (e && e.message) || e));
  const port = Number(env.PORT || 8843); const srv = serve(r, port);
  console.log('relayer', r.wallet.publicKey.toBase58(), 'v' + VERSION, dep.network, 'listening on', port, postman ? '(+ approved-set publisher)' : '');
  // graceful stop: no new connections, let in-flight submissions finish (max 25 s), then exit
  const stop = (sig) => { console.log(sig, 'received: draining'); clearInterval(srv.asp); clearInterval(srv.bal); clearInterval(srv.crank); srv.close();
    const t0 = Date.now(); const wait = setInterval(() => { if (srv.inflight === 0 || Date.now() - t0 > 25_000) { clearInterval(wait); process.exit(0); } }, 200); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
}
