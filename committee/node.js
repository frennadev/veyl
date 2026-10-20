#!/usr/bin/env node
// Veyl batch committee node: one member of the t-of-n committee that decrypts sealed batches' aggregates (never an
// individual swap). It
//   1. takes part in the dealerless key generation (committee/dkg.js) when it has no share yet and DKG_SESSION is set,
//      serving its round messages over HTTP to the other nodes, and keeps its share in STATE_DIR (mode 0600);
//   2. watches every sealed pool of the deployment: for each closed batch it posts its partial decryption of the two
//      aggregates with a Chaum–Pedersen proof (post_share + share_step: the program checks it), and, once t shares are
//      verified, recovers the totals and settles the batch (permissionless; any node or the relayer may do it first);
//   3. closes batches whose epoch is over (also permissionless).
//
//   GET /health                      { ok, index, node, pk, registered, dkg, lastShare, lastSettle, lastError, balanceSol }
//   GET /dkg/<session>/round1|round2 this node's signed DKG messages
//   GET /transcript                  the DKG transcript (public: commitments, encrypted shares, signatures, keys)
//
// Env: COMMITTEE_CONFIG=<json file> { index, t, n, peers: [{ index, url, node, boxKey }] } (or COMMITTEE_JSON inline);
//      NODE_SECRET_KEY (JSON byte array or base58) or NODE_KEY=<keypair file>: the node's Solana key (signs DKG messages,
//      pays for share transactions; its X25519 key for DKG shares is derived from it); STATE_DIR (default
//      ./committee-state-<index>); DKG_SESSION; DEPLOY_JSON | DEPLOY_FILE | NETWORK + RPC_URL; PORT (default 8863);
//      WATCH_MS (3000); SETTLE (1); CLOSE (1); BSGS_BITS (46).
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const nacl = require('tweetnacl'); const bs58 = require('bs58');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const S = require('../sdk/veyl.js'); require('../sdk/shield.js'); require('../sdk/sealed.js'); const J = require('../sdk/bjj.js');
const D = require('./dkg.js'); const CM = require('./lib.js');
const VERSION = require('../package.json').version;

/// The node's X25519 key for DKG shares, derived from its Solana key (one secret to keep).
const boxKeyOf = (kp) => nacl.box.keyPair.fromSecretKey(Uint8Array.from(crypto.createHash('sha256').update(Buffer.concat([Buffer.from('veyl-committee-box'), Buffer.from(kp.secretKey.subarray(0, 32))])).digest()));

/// A dropped connection to the RPC (a connect timeout, ECONNRESET) is retried a few times: resending a signed transaction is safe.
const retryFetch = async (url, init) => { for (let i = 0; ; i++) { try { return await fetch(url, init); } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 500 * 2 ** i)); } } };
class Node {
  /// depLoader: () => the deployment (deploy.<network>.json) or null; read again until it exists (a local deployment is
  /// written after the committee's key generation, since it registers the key).
  constructor({ config, key, stateDir, depLoader = () => null, rpc = null, log = console.log, settle = true, close = true, bits = J.TOTAL_BITS }) {
    this.cfg = config; this.key = key; this.dir = stateDir; this.depLoader = depLoader; this.rpc = rpc; this.conn = null; this.dep = null; this.log = log; this.doSettle = settle; this.doClose = close; this.bits = bits;
    this.box = boxKeyOf(key); this.msgs = {}; this.status = { dkg: 'idle', lastShare: null, lastSettle: null, lastError: null };
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.share = this._read('share.json'); this.transcript = this._read('transcript.json');
    if (this.share) this.status.dkg = 'done';
  }
  _chain() { if (this.V) return true; const dep = this.depLoader(); if (!dep) return false; this.dep = dep; this.conn = new Connection(this.rpc || dep.rpc, { commitment: 'confirmed', fetch: retryFetch });
    this.V = new S.Veyl({ connection: this.conn, programs: dep.programs, payer: this.key }); this.V.lookupTable = dep.lookupTable ? new PublicKey(dep.lookupTable) : null; return true; }
  _read(f) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')); } catch { return null; } }
  _write(f, o, mode = 0o600) { fs.writeFileSync(path.join(this.dir, f), JSON.stringify(o, null, 1), { mode }); }
  get index() { return this.cfg.index; }
  peers() { return this.cfg.peers.map((p) => ({ ...p, boxKey: p.boxKey })); }
  // ---- DKG
  async dkg(session, { timeoutMs = 600_000 } = {}) {
    if (this.share) return this.share; const { index, t, n } = this.cfg; const peers = this.peers();
    if (!peers.find((p) => p.index === index && p.node === this.key.publicKey.toBase58() && p.boxKey === Buffer.from(this.box.publicKey).toString('base64'))) throw new Error('this node is not in the peer list with its own node and box keys');
    this.status.dkg = 'round1'; const r1 = D.round1({ session, index, t, n, boxSecret: this.box.secretKey, peers, nodeKey: this.key }); this.msgs[session] = { round1: r1.msg };
    const r1s = await this._collect(session, 'round1', timeoutMs); r1s[index] = r1.msg;
    this.status.dkg = 'round2'; const r2 = D.round2({ session, index, t, n, boxSecret: this.box.secretKey, peers, r1s, own: r1.own, nodeKey: this.key }); this.msgs[session].round2 = r2.msg;
    const r2s = await this._collect(session, 'round2', timeoutMs); r2s[index] = r2.msg;
    const out = D.finish({ session, index, t, n, peers, r1s, r2s, got: r2.got });
    this.share = { index, t, n, session, sk: out.sk.toString(), pk: D.hexP(out.PK), member: D.hexP(out.members[index - 1]), transcriptHash: out.transcriptHash.toString('hex') };
    this.transcript = out.transcript; this._write('share.json', this.share); this._write('transcript.json', out.transcript, 0o644);
    this.status.dkg = 'done'; this.log(`node ${index}: DKG done, joint key ${this.share.pk.slice(0, 16)}…`); return this.share;
  }
  async _collect(session, round, timeoutMs) { const out = {}; const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { for (const p of this.peers()) { if (p.index === this.index || out[p.index]) continue;
        try { const r = await fetch(`${p.url}/dkg/${encodeURIComponent(session)}/${round}`); if (r.ok) out[p.index] = await r.json(); } catch { /* not up yet */ } }
      if (Object.keys(out).length === this.cfg.n - 1) return out; await CM.sleep(500); }
    throw new Error(`DKG ${round}: timed out waiting for ${this.cfg.n - 1 - Object.keys(out).length} node(s)`); }
  // ---- chain
  /// Is the on-chain committee this node's (same joint key, this member's key and node at its index)?
  async registered() { if (!this.V || !this.share) return false; const c = await this.V.committee(); if (!c) return false;
    return J.enc(c.pk).toString('hex') === this.share.pk && c.members[this.index - 1] && J.enc(c.members[this.index - 1]).toString('hex') === this.share.member && c.nodes[this.index - 1].equals(this.key.publicKey); }
  async tick() {
    if (!this.share || !this._chain()) return; const reg = await this.registered(); this.status.registered = reg; if (!reg) return;
    for (const bp of this.dep.binPools) { const pool = new PublicKey(bp.address); let st; try { st = await this.V.sealedState(pool); } catch { continue; } if (!st) continue;
      try {
        if (this.doClose && st.batch.state === 'open' && BigInt(st.slot) >= st.batch.endSlot) { await this.V.send([this.V.closeBatchIx(this.key.publicKey, pool, st.batch.seq)], [], 1_400_000); this.log(`node ${this.index}: closed ${bp.id} batch ${st.batch.seq}`); }
        for (const b of await CM.pendingBatches(this.V, pool)) { const c = await this.V.committee(); if (b.committeeEpoch !== c.epoch) continue;
          if (!(b.verified & (1 << (this.index - 1)))) { const r = await CM.postShare(this.V, this.key, { member: this.index, sk: BigInt(this.share.sk), binPool: pool, seq: b.seq });
            this.status.lastShare = { pool: bp.id, seq: String(b.seq), txs: r.txs.length, at: new Date().toISOString() }; this.log(`node ${this.index}: share for ${bp.id} batch ${b.seq} verified (${r.txs.length} txs)`); }
          const nb = await this.V.batch(pool, b.seq); let nv = 0; for (let i = 0; i < 8; i++) if (nb.verified & (1 << i)) nv++;
          if (this.doSettle && nb.state === 'closed' && nv >= c.t) { const r = await CM.settle(this.V, this.key, pool, b.seq, { totals: await CM.recoverTotals(this.V, pool, b.seq, this.bits) }); this.status.lastSettle = { pool: bp.id, seq: String(b.seq), at: new Date().toISOString() }; this.log(`node ${this.index}: settled ${bp.id} batch ${b.seq}`); void r; } }
      } catch (e) { this.status.lastError = String(e.message).slice(0, 200); }
    } }
  async health() { let bal = null; try { bal = this.conn ? (await this.conn.getBalance(this.key.publicKey)) / 1e9 : null; } catch {}
    return { ok: true, version: VERSION, index: this.index, t: this.cfg.t, n: this.cfg.n, node: this.key.publicKey.toBase58(), boxKey: Buffer.from(this.box.publicKey).toString('base64'), pk: this.share ? this.share.pk : null,
      registered: !!this.status.registered, dkg: this.status.dkg, lastShare: this.status.lastShare, lastSettle: this.status.lastSettle, lastError: this.status.lastError, balanceSol: bal }; }
  serve(port) {
    const srv = http.createServer(async (req, res) => { const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
      try { const u = new URL(req.url, 'http://x'); const m = u.pathname.match(/^\/dkg\/([^/]+)\/(round1|round2)$/);
        if (u.pathname === '/health') return send(200, await this.health());
        if (u.pathname === '/transcript') return this.transcript ? send(200, this.transcript) : send(404, { error: 'no transcript yet' });
        if (m) { const x = this.msgs[decodeURIComponent(m[1])]; return x && x[m[2]] ? send(200, x[m[2]]) : send(404, { error: 'not yet' }); }
        send(404, { error: 'not found' }); } catch (e) { send(500, { error: String(e.message).slice(0, 200) }); } });
    srv.listen(port); return srv; }
}

function keyFromEnv(env) { if (env.NODE_SECRET_KEY) { const v = env.NODE_SECRET_KEY.trim(); return Keypair.fromSecretKey(v.startsWith('[') ? Uint8Array.from(JSON.parse(v)) : bs58.decode(v)); }
  if (env.NODE_KEY) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(env.NODE_KEY, 'utf8')))); return null; }
function deployFromEnv(env) { try { if (env.DEPLOY_JSON) return JSON.parse(env.DEPLOY_JSON); return JSON.parse(fs.readFileSync(env.DEPLOY_FILE || path.join(__dirname, '..', `deploy.${env.NETWORK || 'local'}.json`), 'utf8')); } catch { return null; } }
module.exports = { Node, boxKeyOf, keyFromEnv };

if (require.main === module) {
  const env = process.env; const key = keyFromEnv(env); if (!key) { console.error('Set NODE_SECRET_KEY (or NODE_KEY=<keypair file>): this member\'s node key.'); process.exit(1); }
  if (process.argv[2] === 'keys') { console.log(JSON.stringify({ node: key.publicKey.toBase58(), boxKey: Buffer.from(boxKeyOf(key).publicKey).toString('base64') })); process.exit(0); }
  // a failed RPC call outside the tick's try/catch (a dropped connection, ECONNRESET) is logged; it must not stop the node
  process.on('unhandledRejection', (e) => console.error('unhandled', (e && e.message) || e));
  const config = env.COMMITTEE_JSON ? JSON.parse(env.COMMITTEE_JSON) : JSON.parse(fs.readFileSync(env.COMMITTEE_CONFIG, 'utf8'));
  const node = new Node({ config, key, stateDir: env.STATE_DIR || path.join(process.cwd(), 'committee-state-' + config.index), depLoader: () => deployFromEnv(env), rpc: env.RPC_URL || null, settle: env.SETTLE !== '0', close: env.CLOSE !== '0', bits: Number(env.BSGS_BITS || J.TOTAL_BITS) });
  const port = Number(env.PORT || 8863); const srv = node.serve(port);
  console.log(`committee node ${config.index} of ${config.n} (t = ${config.t}) v${VERSION} on ${port}, node key ${key.publicKey.toBase58()}`);
  (async () => {
    if (!node.share && env.DKG_SESSION) { try { await node.dkg(env.DKG_SESSION); } catch (e) { node.status.dkg = 'failed: ' + e.message; console.error('DKG failed:', e.message); } }
    if (!node.share) console.log('no key share yet: set DKG_SESSION (the same on every node) to run the key generation');
    const loop = async () => { try { await node.tick(); } catch (e) { node.status.lastError = e.message; } setTimeout(loop, Number(env.WATCH_MS || 3000)); }; loop();
  })();
  const stop = () => { srv.close(); process.exit(0); }; process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
