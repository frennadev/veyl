// Veyl relayer for Solana. Submits proofs so the user's wallet never touches the transaction.
// It cannot steal or redirect anything (recipient, fee, route and deadline are hashed into the proof's context, and
// the pool program checks them), but it CAN see the request IP, so this server never logs IPs and only keeps a
// rate-limit counter in memory.
//
//   GET  /info                 relayer wallet, fee range, programs, lookup table
//   GET  /state?pool=<pubkey>  the pool's leaves (tree order) and approved labels, for building proofs
//   GET  /pools                bin pools with their current state (quotes are computed on the device)
//   POST /fee                  { kind, d, mint | legs, value }  -> { feeBps } that covers this relayer's cost for the request
//   POST /drip                 { to } devnet/local test tokens from the mock mints (FAUCET_KEY = the deployer, the mints' authority); never on mainnet
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
// postman.js (approved-set publisher), faucet.js (/drip), screening.js (denylist), env.js (keys and deployment from env).
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
  info() { return { faucet: !!this.faucet, address: this.wallet.publicKey.toBase58(), minFeeBps: this.minFeeBps, maxFeeBps: this.maxFeeBps, minFee: this.minFeeTable(), programs: this.dep.programs, lookupTable: this.dep.lookupTable, entrySigner: this.V.signerPda().toBase58(), network: this.dep.network, postman: this.postman ? this.postman.publicKey.toBase58() : this.dep.postman, kinds: Object.keys(WORST), signedKinds: [...SIGNED] }; }
  /// Liveness for the host's health check: version, network, the hot wallet and its last known SOL balance (refreshed every
  /// minute in the background; it pays transaction fees and recipients' token-account rent, and never holds user funds).
  health() { return { ok: true, version: VERSION, network: this.dep.network, relayer: this.wallet.publicKey.toBase58(), balanceSol: this.balance === undefined ? null : this.balance / 1e9, lowBalance: this.balance !== undefined && this.balance < LOW_BALANCE_LAMPORTS, publisher: !!this.postman }; }
  async refreshBalance() { try { this.balance = await this.conn.getBalance(this.wallet.publicKey); if (this.balance < LOW_BALANCE_LAMPORTS) console.error('relayer balance low:', this.balance / 1e9, 'SOL'); } catch { /* RPC hiccup: keep the last value */ } }
  async binPools() { const out = []; for (const b of this.dep.binPools) { const p = await this.V.binPool(b.address); out.push({ ...b, activeId: p.activeId, lowestId: p.lowestId, highestId: p.highestId, seeded: p.seeded, fee: (await this.V.currentFee(b.address)).toString(), price: S.priceOf(p.basePrice, p.binStep, p.activeId).toString(),
      protocolShare: p.protocolShare, totalFeeX: p.totalFeeX.toString(), totalFeeY: p.totalFeeY.toString(), rewards: p.rewards.map((r, i) => (r.initialized ? { index: i, mint: r.mint.toBase58(), rateQ64: r.rate.toString(), end: Number(r.end) } : null)).filter(Boolean) }); } return out; }
}
const Fees = require('./fees.js'), Notes = require('./notes.js'), Shielded = require('./shielded.js'), Sealed = require('./sealed.js'), Postman = require('./postman.js'), Faucet = require('./faucet.js');
class Relayer extends Faucet(Postman(Sealed(Shielded(Notes(Fees(RelayerCore)))))) {}
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
