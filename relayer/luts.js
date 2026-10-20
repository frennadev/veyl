// Address lookup tables for pools listed after the deploy. The deploy's tables (deploy.<network>.json lookupTable /
// lookupTables) hold every address of the pools it made; a pool anyone lists later has none there, so its private actions
// carry every account in full (32 bytes instead of a 1-byte index: tests/new-pools.js measures how close that gets to the
// 1,232-byte limit) and a public add of 16 bins on it no longer fits one transaction. This relayer keeps its own tables
// (it is their authority and pays their rent) and adds the accounts of each pool it finds (discover), served in /info as
// poolLookupTables; the app loads them next to the deployment's.
// Part of the Relayer class (relayer/relayer.js composes these mixins in one place).
//
// Rent is the relayer's, so the spend is bounded (REVIEW.md I-5 for the deploy's table):
//   - only pools read from veyl_bin itself (discover's getProgramAccounts), listed (not delisted) and seeded (holding
//     liquidity); never an address a request names: every address is derived here from the pool account
//     (pool, mints, vaults, the entry / shielded / fee token accounts, and for the active bin's chunk and its two
//     neighbours the bin array, the LpAcc and the shielded aggregate's share account), and only accounts that exist
//   - at most POOL_LUT_PER_POOL addresses per pool (default 24) and POOL_LUT_PER_HOUR new addresses an hour (default 200)
//   - at most POOL_LUT_MAX_TABLES tables (default 4, 256 addresses each: about 0.23 SOL of rent when all are full, which a
//     deactivate + close gets back); the tables are found again after a restart (POOL_LOOKUP_TABLES, else the chain), and
//     when they cannot be found this relayer makes none rather than leak rent on every restart
//   - POOL_LUTS=0 turns it off.
// A table's entries never change once added (tables only grow, and a closed one cannot be re-made at the same address), so
// a client compiling against one of these tables cannot be redirected to other accounts; at worst a deactivated table makes
// a transaction fail. Addresses added in the current slot are left out until the next one (sdk usableLut).
'use strict';
const { PublicKey, AddressLookupTableProgram } = require('@solana/web3.js');
const S = require('../sdk/veyl.js');
const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);
const b58 = (k) => new PublicKey(k).toBase58();
module.exports = (Base) => class Luts extends Base {
  /// This relayer's tables: POOL_LOOKUP_TABLES (comma separated) when set, else every table on chain whose authority is
  /// this wallet (not the deployment's). null when the chain cannot be asked: then no table is made (see above).
  async _loadPoolLuts() { if (this.poolLuts) return this.poolLuts; if (this._lutLoadFail && Date.now() - this._lutLoadFail < 600_000) return null; /* a refused scan is retried every 10 min */ const dep = new Set([this.dep.lookupTable, ...(this.dep.lookupTables || [])].filter(Boolean).map(b58));
    let keys; if (process.env.POOL_LOOKUP_TABLES) keys = process.env.POOL_LOOKUP_TABLES.split(',').map((x) => x.trim()).filter(Boolean).map(b58);
    else { try { const rows = await this.conn.getProgramAccounts(AddressLookupTableProgram.programId, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 21, bytes: '2' /* Some(authority): byte 1 */ } }, { memcmp: { offset: 22, bytes: this.wallet.publicKey.toBase58() } }] });
      keys = rows.map((r) => r.pubkey.toBase58()); } catch (e) { this._lutLoadFail = Date.now(); console.error('pool lookup tables: cannot list this wallet\'s tables (' + String(e.message).slice(0, 80) + '); set POOL_LOOKUP_TABLES'); return null; } }
    const out = []; for (const k of keys.filter((x) => !dep.has(x))) { const t = (await this.conn.getAddressLookupTable(new PublicKey(k))).value;
      if (t && t.isActive() && t.state.authority && t.state.authority.equals(this.wallet.publicKey)) out.push(new PublicKey(k)); }
    this.poolLuts = out.sort((a, b) => a.toBase58().localeCompare(b.toBase58())); this._useLuts(); return this.poolLuts; }
  /// The relayer's own transactions compile against the deployment's tables and these.
  _useLuts() { this.V.lookupExtra = [...(this.dep.lookupTables || []).map((t) => new PublicKey(t)), ...(this.poolLuts || [])]; }
  /// Every address already in a table this relayer uses (the deployment's and its own).
  async _lutAddresses() { const have = new Set(); for (const k of [this.dep.lookupTable, ...(this.dep.lookupTables || []), ...(this.poolLuts || [])].filter(Boolean)) {
    const t = (await this.conn.getAddressLookupTable(new PublicKey(k))).value; if (t) for (const a of t.state.addresses) have.add(a.toBase58()); } return have; }
  /// The accounts of a pool's private actions, most useful first, derived from the decoded pool only.
  poolLutAddresses(p) { const V = this.V; const pool = p.address; const signer = V.signerPda(), shield = V.shieldPda(), me = this.wallet.publicKey; const out = [pool, p.mintX, p.mintY, p.vaultX, p.vaultY];
    for (const [m, tp] of [[p.mintX, p.tokenProgramX], [p.mintY, p.tokenProgramY]]) out.push(V.ata(m, signer, tp), V.ata(m, shield, tp), V.ata(m, me, tp));
    const c = S.chunkOf(p.activeId); for (const ch of [c, c - 1, c + 1]) out.push(V.binArrayPda(pool, ch), V.lpAccPda(pool, ch), V.sharesPda(pool, V.shieldOwner(), signer, ch));
    return out; }
  /// Add the accounts of every listed, seeded pool (`pools`: decoded BinPools, default the last discover's) that are not in
  /// a table yet, within the caps above. Returns { added, tables }. One at a time.
  async syncPoolLuts(pools = this._chainPools || []) { if (process.env.POOL_LUTS === '0') return { added: 0, tables: [] }; if (this._lutJob) return this._lutJob;
    this._lutJob = (async () => { try {
      if (!(await this._loadPoolLuts())) return { added: 0, tables: [] };
      const perPool = num('POOL_LUT_PER_POOL', 24), perHour = num('POOL_LUT_PER_HOUR', 200), maxTables = num('POOL_LUT_MAX_TABLES', 4);
      const now = Date.now(); this._lutLog = (this._lutLog || []).filter((x) => now - x.at < 3_600_000); let budget = perHour - this._lutLog.reduce((s, x) => s + x.n, 0);
      const have = await this._lutAddresses(); this._lutAdded = this._lutAdded || new Map(); const add = []; const credit = new Map();
      for (const p of pools) { if (budget <= add.length) break; if (p.delisted || !p.seeded) continue; const key = b58(p.address); const used = this._lutAdded.get(key) || 0; if (used >= perPool) continue;
        const want = [...new Map(this.poolLutAddresses(p).map((a) => [b58(a), new PublicKey(a)])).values()].filter((a) => !have.has(a.toBase58()));
        if (!want.length) continue; const infos = await this.conn.getMultipleAccountsInfo(want, 'confirmed'); const real = want.filter((a, i) => infos[i]).slice(0, Math.min(perPool - used, budget - add.length));
        for (const a of real) { have.add(a.toBase58()); add.push(a); } if (real.length) credit.set(key, real.length); }
      if (!add.length) return { added: 0, tables: this.poolLuts.map(b58) };
      let room = (maxTables - this.poolLuts.length) * 256; for (const k of this.poolLuts) { const t = (await this.conn.getAddressLookupTable(k)).value; room += t ? 256 - t.state.addresses.length : 0; }
      const part = add.slice(0, Math.max(0, room)); if (!part.length) { if (!this._lutFull) console.error('pool lookup tables are full (POOL_LUT_MAX_TABLES=' + maxTables + '): new pools go without'); this._lutFull = true; return { added: 0, tables: this.poolLuts.map(b58) }; }
      const tables = await this.V.fillLookupTables(this.wallet, part, this.poolLuts); const made = tables.filter((t) => !this.poolLuts.some((k) => k.equals(t)));
      this.poolLuts = tables; this._useLuts(); this._lutLog.push({ at: now, n: part.length });
      let left = part.length; for (const [k, n] of credit) { const c = Math.min(n, left); left -= c; this._lutAdded.set(k, (this._lutAdded.get(k) || 0) + c); }
      if (made.length) console.log('pool lookup table made:', made.map(b58).join(', '), '(keep it: POOL_LOOKUP_TABLES=' + this.poolLuts.map(b58).join(',') + ')');
      return { added: part.length, tables: this.poolLuts.map(b58) }; } finally { this._lutJob = null; } })();
    return this._lutJob; }
};
