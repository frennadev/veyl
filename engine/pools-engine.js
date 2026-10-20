// Open pool listing for the browser engine: tokens keyed by mint (symbols stay aliases for the deployment's own tokens),
// every bin pool on chain (the deployment's curated ones and the ones anyone listed since, with their tier, status and
// listing bond), the factory's fee tiers, the token checks veyl_bin makes, and creating a pool. Installed onto the Engine
// class by sol-entry.js; the Sandbox overrides the few chain reads and writes marked "hook" below.
import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
const S = require('../sdk/veyl.js');
const b58 = (k) => new PublicKey(k).toBase58();
const short = (m) => m.slice(0, 4) + '…' + m.slice(-4);
/// Printable text from on-chain metadata: control characters out, trimmed, capped.
const clean = (s, n) => { const t = String(s || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim(); return t.length > n ? t.slice(0, n) : t; };
const POOLS_TTL = 30_000, FACTORY_TTL = 60_000, MINT_TTL = 600_000;
/// Why a Token-2022 extension keeps a token out of the pools (user-facing).
const EXT_TEXT = { 1: 'it takes a fee on every transfer, so the pool would receive less than it accounts for', 3: 'its issuer can close the token', 4: 'it uses confidential transfers, which a pool cannot account for',
  6: 'new token accounts start frozen', 9: 'it cannot be transferred', 10: 'its balance grows with interest the pool would not account for', 12: 'its issuer can move tokens out of any account, the pool\'s included',
  14: 'every transfer runs its issuer\'s own program', 16: 'it uses confidential transfers, which a pool cannot account for', 24: 'it uses confidential transfers, which a pool cannot account for', 25: 'its issuer can rescale every balance',
  26: 'its issuer can pause every transfer', 28: 'its issuer controls who may burn it' };
const upperSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

/// Errors of the pool calls carry a .code: POOL_EXISTS, TOKEN_REFUSED, BOND_LOW, BAD_TIER, BAD_PRICE (createPool); NO_WALLET;
/// NO_BOND, NOT_CREATOR, BOND_LOCKED, DELISTED (releaseBond); NOT_FOUND (tokenInfo).
export class PoolError extends Error { constructor(code, message) { super(message); this.code = code; } }

export function installPools(Engine) {
  const P = Engine.prototype;
  Engine.PROTOCOL_FEE_BPS = S.PROTOCOL_FEE_BPS;
  Engine.PoolError = PoolError;

  // ---------------------------------------------------------------------------------------------- tokens keyed by mint
  /// The key `k` (a symbol or a mint) is known by in this.tokens: the symbol of a listed token, the mint of any other; null.
  P.tokKey = function (k) { if (k === null || k === undefined) return null; if (this.tokens[k]) return k; let m; try { m = b58(k); } catch { return null; }
    if (this.tokens[m]) return m; const by = this._byMint || (this._byMint = new Map(Object.entries(this.tokens).map(([s, t]) => [t.mint, s]))); return by.get(m) || null; };
  P.tok = function (k) { const s = this.tokKey(k); if (!s) throw new Error('unknown token ' + k); return this.tokens[s]; };
  P.symOf = function (mint) { try { return this.tokKey(b58(mint)) || undefined; } catch { return undefined; } };
  /// What a key shows as: the listed symbol, else the token's own symbol (metadata), else the key.
  P.tokLabel = function (k) { const s = this.tokKey(k); const t = s && this.tokens[s]; return t ? (t.listed === false ? t.symbol || short(s) : s) : String(k); };
  /// A token outside the deployment's list, kept under its mint (tok / fmt / unit / humanPrice work with it from now on).
  P._registerToken = function (info) { if (this.tokKey(info.mint)) return; this.tokens[info.mint] = { mint: info.mint, decimals: info.decimals, symbol: info.symbol, name: info.name, program: info.program, listed: false };
    this._byMint = null; if (this.zw) this.zw.addMint(info.mint, { sym: info.mint, decimals: info.decimals }); };
  /// hook: a mint read from the chain (parseMint shape), cached; null when the address holds no mint.
  P._readMint = async function (m) { const c = (this._mints ||= new Map()).get(m); if (c && Date.now() - c.at < MINT_TTL) return c.v;
    const v = await this.V.mint(new PublicKey(m)); this._mints.set(m, { v, at: Date.now() }); return v; };
  /// { mint, symbol, name, decimals, program: 'spl' | 'token2022', listed }: the deployment's own entry for a listed token, else
  /// the token's Token-2022 metadata, else the short mint. Cached; a token not listed is registered under its mint.
  P.tokenInfo = async function (mint) { const m = b58(mint); const c = (this._tinfo ||= new Map()).get(m); if (c) return c;
    const key = this.tokKey(m); const listed = key && this.tokens[key].listed !== false ? key : null; let pm = null;
    try { pm = await this._readMint(m); } catch (e) { if (!listed) throw e; }
    if (!pm && !listed) throw new PoolError('NOT_FOUND', 'There is no token at ' + short(m) + ' on ' + (this.cfg.chainName || 'Solana') + '.');
    const meta = pm && pm.metadata; const t = listed ? this.tokens[listed] : null;
    const info = { mint: m, symbol: t ? listed : clean(meta && meta.symbol, 12) || short(m), name: t ? clean(t.name, 40) || clean(meta && meta.name, 40) || listed : clean(meta && meta.name, 40) || short(m),
      decimals: t ? t.decimals : pm.decimals, program: pm ? pm.program : 'spl', listed: !!t };
    if (!t) this._registerToken(info); this._tinfo.set(m, info); return info; };
  /// { ok, info, reasons: [{ code, text }] }: whether veyl_bin would list this token (classic SPL Token: yes; Token-2022: only with
  /// metadata / group extensions), with the reasons it would refuse it in plain words.
  P.checkToken = async function (mint) { let m; try { m = b58(mint); } catch { return { ok: false, info: null, reasons: [{ code: 'BAD_ADDRESS', text: 'That is not a Solana address.' }] }; }
    let pm; try { pm = await this._readMint(m); } catch { return { ok: false, info: null, reasons: [{ code: 'NETWORK', text: 'This token could not be read from the network. Try again in a moment.' }] }; }
    if (!pm) return { ok: false, info: null, reasons: [{ code: 'NOT_A_TOKEN', text: 'This address is not a token on ' + (this.cfg.chainName || 'Solana') + '.' }] };
    const info = await this.tokenInfo(m); const reasons = [];
    if (!pm.initialized) reasons.push({ code: 'UNINITIALIZED', text: 'This token has not been set up by its issuer yet.' });
    for (const e of S.refusedExtensions(pm)) reasons.push({ code: 'EXT_' + upperSnake(e.name), text: 'This token can\'t go in a pool: ' + (EXT_TEXT[e.type] || 'it uses a Token-2022 feature (' + e.name + ') that can change transfers or balances') + '.' });
    return { ok: !reasons.length, info, reasons }; };

  // ---------------------------------------------------------------------------------------------- the factory: tiers, bond
  P._factory = async function (fresh = false) { const c = this._fac; if (!fresh && c && Date.now() - c.at < FACTORY_TTL) return c.v; const v = await this.V.factory(); this._fac = { v, at: Date.now() }; return v; };
  /// A factory tier as the app shows it: { id, label, category, feePips, binStep } (feePips: the base fee, 1e-6: 500 = 0.05%).
  P._tierRow = function (t) { const c = (this.cfg.feeTiers || []).find((x) => x.binStep === t.binStep && (x.baseFee === undefined || x.baseFee === t.baseFee)) || {};
    return { id: t.index, label: c.label || S.tierLabel(t.binStep, t.baseFee), category: c.category || S.tierCategory(t.binStep), feePips: t.baseFee, binStep: t.binStep }; };
  /// The tiers a new pool can take (enabled on the factory), in factory order.
  P.listTiers = async function () { const f = await this._factory(); return f ? f.tiers.filter((t) => t.enabled).map((t) => this._tierRow(t)) : []; };
  /// The listing bond a new pool costs its creator: { amount (lamports, bigint), lockDays }.
  P.bondTerms = async function () { const f = await this._factory(); if (!f) throw new Error('The pool factory is not deployed on this network.'); return { amount: f.bondLamports, lockDays: Number(f.bondLock) / 86_400 }; };
  /// A pool's tier, from its own account (the tier index and fees it was created with).
  P._poolTier = function (bp) { return this._tierRow({ index: bp.feeTier, binStep: bp.binStep, baseFee: bp.baseFee }); };

  // ---------------------------------------------------------------------------------------------- every pool
  /// hook: every bin pool on chain, decoded (getProgramAccounts on veyl_bin).
  P._discover = async function () { return this.V.binPools(); };
  /// hook: the bonds of these pools (null where none).
  P._bonds = async function (addrs) { return this.V.bonds(addrs); };
  /// hook: how many bin pools exist (addresses only).
  P._poolKeys = async function () { return (await this.V.binPools({ keysOnly: true })).map(b58); };
  P._statusOf = (row, bp, bond, now) => (bp && bp.delisted ? 'delisted' : row && !row.discovered ? 'verified' : bond && now < Number(bond.unlockAt) ? 'unverified' : 'verified');
  /// The crowd a pool's private actions blend into: the fewer approved shielded deposits of its two tokens (last sync), or null.
  P._crowd = function (mx, my) { const d = this.shieldState && this.shieldState.deposits; if (!d) return null; return Math.min(Number(d[mx] || 0), Number(d[my] || 0)); };
  P._loadDirectory = async function () {
    const [chain] = await Promise.all([this._discover(), this._factory().catch(() => null)]); const now = Math.floor(Date.now() / 1000);
    const cfgRows = this.cfg.binPools.filter((r) => !r.discovered); const known = new Set(cfgRows.map((r) => r.address));
    const fresh = chain.filter((bp) => !known.has(b58(bp.address)));
    await Promise.all([...new Set(fresh.flatMap((bp) => [b58(bp.mintX), b58(bp.mintY)]))].map((m) => this.tokenInfo(m).catch(() => null)));
    const bonds = await this._bonds(chain.map((bp) => bp.address)); const byAddr = new Map(chain.map((bp, i) => [b58(bp.address), { bp, bond: bonds[i] }]));
    const meta = (row, bp, bond) => { const mx = bp ? b58(bp.mintX) : this.tok(row.x).mint, my = bp ? b58(bp.mintY) : this.tok(row.y).mint;
      return { mintX: mx, mintY: my, tier: bp ? this._poolTier(bp) : null, status: this._statusOf(row, bp, bond, now), crowd: this._crowd(mx, my), createdAt: bond ? Number(bond.createdAt) * 1000 : null, creator: bond ? b58(bond.creator) : null }; };
    const rows = [];
    for (const r of cfgRows) { const h = byAddr.get(r.address); rows.push({ ...r, bs: r.bs ?? r.binStep, base: r.base ?? (r.baseFee !== undefined ? r.baseFee / 1e4 : undefined), ...meta(r, h && h.bp, h && h.bond) }); }
    for (const bp of fresh) { const mx = b58(bp.mintX), my = b58(bp.mintY); const x = this.tokKey(mx), y = this.tokKey(my); if (!x || !y) continue; const h = byAddr.get(b58(bp.address));
      const id = [x, y].map((k) => (this.tokens[k].listed === false ? k : k.toLowerCase())).join('-') + '-' + bp.binStep;
      rows.push({ id, x, y, bs: bp.binStep, base: bp.baseFee / 1e4, binStep: bp.binStep, baseFee: bp.baseFee, address: b58(bp.address), discovered: true, ...meta(null, bp, h.bond) }); }
    // discovered pools join cfg.binPools, so every other call (poolState, quoteRoute, positions, stats) knows them
    for (const r of rows.filter((x) => x.discovered)) { const i = this.cfg.binPools.findIndex((b) => b.address === r.address); if (i >= 0) this.cfg.binPools[i] = r; else this.cfg.binPools.push(r); if (this.zw) this.zw.addPool({ address: r.address, mintX: r.mintX, mintY: r.mintY, x: r.x, y: r.y }); }
    return (this._dir = { at: Date.now(), rows, count: chain.length }); };
  /// Every pool: the deployment's (status 'verified'), then the ones listed on chain since ('unverified' while their bond is
  /// locked, then 'verified'); delisted ones ('delisted') only with includeDelisted. Rows: id, x, y (keys for tok / fmt /
  /// humanPrice), bs, base, address, mintX, mintY, tier { id, feePips, binStep, label, category }, status, crowd, createdAt (ms,
  /// from the bond; null once released), creator. Read from the chain at most every 30 s (fresh: now).
  P.listPools = async function ({ includeDelisted = false, fresh = false } = {}) { let c = this._dir;
    if (!c || fresh || Date.now() - c.at > POOLS_TTL) { if (!this._dirP) this._dirP = this._loadDirectory().finally(() => { this._dirP = null; }); c = await this._dirP; }
    return c.rows.filter((r) => includeDelisted || r.status !== 'delisted').map((r) => ({ ...r, tier: r.tier && { ...r.tier } })); };
  /// The number of bin pools on chain (addresses only: cheap). A change means a pool was listed: listPools({ fresh: true }).
  P.poolCount = async function () { return (await this._poolKeys()).length; };
  P._dirRow = function (addr) { const a = b58(addr); return this._dir ? this._dir.rows.find((r) => r.address === a) || null : null; };
  /// A pool's status now (cached directory row, else its account and bond).
  P.poolStatus = async function (addr, bp) { const row = this.poolCfg(addr); bp = bp || (await this.V.binPool(new PublicKey(addr))); if (bp && bp.delisted) return 'delisted';
    if (row && !row.discovered) return 'verified'; const d = this._dirRow(addr); if (d) return d.status; const [bond] = await this._bonds([new PublicKey(addr)]); return this._statusOf(row, bp, bond, Math.floor(Date.now() / 1000)); };
  /// The pool of a pair at a tier (either order), or null.
  P.poolFor = async function (mintA, mintB, tierId) { const f = await this._factory(); const t = f && f.tiers[Number(tierId)]; if (!t) return null;
    let x, y; try { [x, y] = S.canonicalPair(mintA, mintB); } catch { return null; } const addr = this.V.binPoolPda(x, y, t.binStep); return (await this.V.binPool(addr)) ? addr.toBase58() : null; };

  // ---------------------------------------------------------------------------------------------- creating a pool, its bond
  /// List a pool: `price` in units of B per A. The engine puts the mints in canonical order (inverting the price when they
  /// swap), scales by the decimals, and the wallet signs one transaction (two when it does not fit): create_pool (the
  /// creator pays the pool's rent and the factory's bond), then whatever the pair's tokens still need for private actions
  /// (the entry program's vault and the shielded pool's vault for each mint: anyone may create them) and the relayer's fee
  /// account. -> { tx, address }. Errors carry .code (see PoolError).
  P.createPool = async function ({ mintA, mintB, tierId, price }) {
    if (!this.pk) throw new PoolError('NO_WALLET', 'Connect a wallet first.'); let a, b;
    try { a = b58(mintA); b = b58(mintB); } catch { throw new PoolError('TOKEN_REFUSED', 'Choose two tokens.'); } if (a === b) throw new PoolError('TOKEN_REFUSED', 'Choose two different tokens.');
    const human = Number(price); if (!(human > 0) || !Number.isFinite(human)) throw new PoolError('BAD_PRICE', 'Set an opening price above zero.');
    this.log('Checking the tokens'); const checks = await Promise.all([this.checkToken(a), this.checkToken(b)]);
    for (const c of checks) if (!c.ok) throw new PoolError('TOKEN_REFUSED', (c.reasons[0] && c.reasons[0].text) || 'This token can\'t go in a pool.');
    const f = await this._factory(true); if (!f) throw new PoolError('BAD_TIER', 'The pool factory is not deployed on this network.');
    const t = f.tiers[Number(tierId)]; if (!t || !t.enabled) throw new PoolError('BAD_TIER', 'That fee tier is not open for new pools.');
    const [x, y, flipped] = S.canonicalPair(a, b); const dec = (m) => checks.find((c) => c.info.mint === m.toBase58()).info.decimals;
    const basePrice = S.priceQ(flipped ? 1 / human : human, dec(x), dec(y)); if (basePrice <= 0n || basePrice >= 1n << 255n) throw new PoolError('BAD_PRICE', 'That opening price is outside what a pool can hold.');
    const address = this.V.binPoolPda(x, y, t.binStep); if (await this.V.binPool(address)) throw new PoolError('POOL_EXISTS', 'This pool already exists.');
    const bond = this.pk.equals(f.authority) ? 0n : f.bondLamports;
    const r = await this._createPoolExec({ x, y, tier: t, basePrice, bond, address });
    this._dir = null; this._fac = null; try { await this.listPools({ fresh: true }); } catch { /* listed on the next refresh */ }
    return { tx: r.tx, address: address.toBase58() }; };
  /// Transaction errors of a pool call as PoolErrors (veyl_bin: 6000 + its BinError index).
  P._poolErr = function (e) { const m = String((e && e.message) || e) + ' ' + JSON.stringify((e && (e.logs || e.transactionLogs)) || '');
    const is = (re) => re.test(m); if (e && e.code) return e;
    if (is(/"Custom":6020\b|BadTier/)) return new PoolError('BAD_TIER', 'That fee tier is not open for new pools.');
    if (is(/"Custom":6021\b|BadMint/)) return new PoolError('TOKEN_REFUSED', 'One of the tokens can\'t go in a pool.');
    if (is(/"Custom":6022\b|Delisted/)) return new PoolError('DELISTED', 'This pool is delisted: its bond went to the treasury.');
    if (is(/"Custom":6023\b|BondLocked/)) return new PoolError('BOND_LOCKED', 'The bond is still locked.');
    if (is(/already in use/)) return new PoolError('POOL_EXISTS', 'This pool already exists.');
    if (is(/insufficient lamports|InsufficientFunds|insufficient funds|"Custom":1\}/)) return new PoolError('BOND_LOW', 'This wallet does not hold enough SOL for the bond and the pool\'s rent.');
    if (is(/"Custom":6000\b|BadParams/)) return new PoolError('BAD_PRICE', 'That opening price is outside what a pool can hold.');
    return e; };
  /// The instructions that make a mint usable for private actions, where missing: the entry vault (the ATA of the entry's
  /// signer PDA, what init_vault creates), the shielded vault (the ATA of the shield PDA) and the relayer's fee account. All
  /// idempotent creates, paid by `payer`. -> { ixs, rent (lamports) }.
  P._vaultIxs = async function (payer, mints) { const ixs = []; let n = 0; let relayer = null; try { relayer = await this._relayerAddr(); } catch { /* no relayer: it makes its own */ }
    for (const m of mints) { const tp = await this.V.tokenProgram(m); const owners = [this.V.signerPda(), this.V.shieldPda(), ...(relayer ? [relayer] : [])];
      const infos = await this.conn.getMultipleAccountsInfo(owners.map((o) => this.V.ata(m, o, tp)));
      owners.forEach((o, i) => { if (!infos[i]) { ixs.push(this.ataIx(payer, m, o, tp)); n++; } }); }
    return { ixs, rent: n * S.rentOf(S.SIZES.tokenAccount) }; };
  /// hook: send create_pool (+ vaults) with the wallet. -> { tx }.
  P._createPoolExec = async function ({ x, y, tier, basePrice, bond }) {
    const create = await this.V.createPoolIx(this.pk, x, y, tier.index, basePrice, 0, tier.binStep); const v = await this._vaultIxs(this.pk, [x, y]);
    const need = bond + BigInt(S.rentOf(S.SIZES.binPool) + S.rentOf(S.SIZES.bond) + 2 * S.rentOf(S.SIZES.tokenAccount) + v.rent) + 50_000n; const have = await this.solBalance();
    if (have < need) throw new PoolError('BOND_LOW', 'Creating this pool takes about ' + +(Number(need) / 1e9).toFixed(3) + ' SOL: the ' + +(Number(bond) / 1e9).toFixed(3) + ' SOL bond (refundable after the lock) and the accounts\' rent. This wallet holds ' + +(Number(have) / 1e9).toFixed(3) + ' SOL.');
    const one = [create, ...v.ixs]; const groups = v.ixs.length && (await this._bytes(one, this.pk)) > Engine.MAX_TX ? [[create], v.ixs] : [one];
    try { return { tx: await this._sendAll(groups, 400_000) }; } catch (e) { throw this._poolErr(e); } };
  /// Make a token usable for private actions if a pool of it was listed without (anyone may; the wallet pays the rent). -> { tx } | null.
  P.ensureTokenVaults = async function (mint) { if (!this.pk) throw new PoolError('NO_WALLET', 'Connect a wallet first.'); const v = await this._vaultIxs(this.pk, [new PublicKey(mint)]); if (!v.ixs.length) return null; return { tx: await this._sendAll([v.ixs], 200_000) }; };
  /// A pool's listing bond: { amount (lamports), creator, lockedUntil (unix s), createdAt (unix s), releasable (lock over, not
  /// delisted), mine (this wallet made it) } | null (released, forfeited, or never made).
  P.bond = async function (pool) { const [b] = await this._bonds([new PublicKey(pool)]); if (!b) return null; const bp = await this.V.binPool(new PublicKey(pool)); const now = Math.floor(Date.now() / 1000);
    return { amount: b.amount, creator: b58(b.creator), lockedUntil: Number(b.unlockAt), createdAt: Number(b.createdAt), releasable: now >= Number(b.unlockAt) && !(bp && bp.delisted), mine: !!this.account && b58(b.creator) === this.account }; };
  /// The creator takes the bond (and its account's rent) back once the lock is over. -> { tx }.
  P.releaseBond = async function (pool) { if (!this.pk) throw new PoolError('NO_WALLET', 'Connect a wallet first.'); const b = await this.bond(pool);
    if (!b) throw new PoolError('NO_BOND', 'This pool has no bond left to release.'); if (b.creator !== this.account) throw new PoolError('NOT_CREATOR', 'Only the wallet that created this pool can release its bond.');
    if (!b.releasable) { const bp = await this.V.binPool(new PublicKey(pool)); if (bp && bp.delisted) throw new PoolError('DELISTED', 'This pool is delisted: its bond went to the treasury.'); throw new PoolError('BOND_LOCKED', 'The bond is locked until ' + new Date(b.lockedUntil * 1000).toISOString().slice(0, 10) + '.'); }
    const r = await this._releaseBondExec(new PublicKey(pool)); this._dir = null; return r; };
  /// hook: send release_bond with the wallet. -> { tx }.
  P._releaseBondExec = async function (pool) { try { return { tx: await this._sendAll([[this.V.releaseBondIx(this.pk, pool)]], 200_000) }; } catch (e) { throw this._poolErr(e); } };

  // ---------------------------------------------------------------------------------------------- symbols or mints, everywhere
  /// Calls that take a token (first argument, or the first two) also take its mint: the key is resolved first (an unseen mint
  /// is read from the chain and registered by the async ones). `proto`'s own methods only, so a subclass wraps its overrides.
  Engine.acceptMints = function (proto) { const own = (k) => Object.prototype.hasOwnProperty.call(proto, k) && typeof proto[k] === 'function';
    const res = async (e, k) => { if (k === null || k === undefined || e.tokKey(k)) return e.tokKey(k) ?? k; try { new PublicKey(k); } catch { return k; } try { await e.tokenInfo(k); } catch { return k; } return e.tokKey(k) ?? k; };
    const wrapA = (name, n) => { if (!own(name) || proto[name]._mints) return; const f = proto[name]; const g = async function (...a) { for (let i = 0; i < n; i++) a[i] = await res(this, a[i]); return f.apply(this, a); }; g._mints = true; proto[name] = g; };
    const wrapS = (name) => { if (!own(name) || proto[name]._mints) return; const f = proto[name]; const g = function (k, ...a) { return f.call(this, this.tokKey(k) ?? k, ...a); }; g._mints = true; proto[name] = g; };
    for (const k of ['deposit', 'withdraw', 'publicBalance', 'shieldDeposit', 'send', 'shieldWithdraw']) wrapA(k, 1);
    for (const k of ['swap', 'swapPublic', 'quoteRoute', 'shieldSwap']) wrapA(k, 2);
    for (const k of ['privateBalance', 'shieldBalance', 'linkRisks', 'recentDeposits', 'crowdSize']) wrapS(k); };
}
