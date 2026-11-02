// Deposit caps (sdk/caps.js): where they come from, what /info serves, and how much of each token is shielded now.
// Part of the Relayer class (relayer/relayer.js composes these mixins in one place). The publisher (postman.js) enforces them.
//   CAPS_JSON='{"perDeposit":{"USDC":10000}}'   replaces the config's caps (the whole object);  CAPS=off   no caps at all.
//   Else config/<NETWORK>.json "caps" (the relayer image copies config/). Unset everywhere: off (devnet / local unchanged).
'use strict';
const fs = require('fs'); const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const C = require('../sdk/caps.js');
/// The caps for a network from env, else its config file; null when off.
function capsFromEnv(env, network) {
  if (/^(0|off|false|no)$/i.test(String(env.CAPS || ''))) return null;
  if (env.CAPS_JSON) return C.normCaps(JSON.parse(env.CAPS_JSON));
  try { return C.normCaps(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', network + '.json'), 'utf8')).caps); } catch { return null; }
}
const ROOM_FRESH_MS = 120_000;
module.exports = (Base) => class Caps extends Base {
  constructor(o) { super(o); this.caps = o.caps !== undefined ? C.normCaps(o.caps) : capsFromEnv(process.env, this.dep.network); this.capRoom = {}; }
  /// { sym, mint, decimals, usd } for a mint this relayer knows (deployment tokens by symbol, discovered ones by mint).
  _capTok(mint) { const k = new PublicKey(mint).toBase58(); const s = this.symOf[k]; if (!s) return { sym: k, mint: k, decimals: 0, usd: 0 };
    const usd = s.discovered ? (this.derivedPrices && this.derivedPrices[k]) || 0 : this.prices[s.sym] || 0; return { sym: s.sym, mint: k, decimals: s.decimals, usd }; }
  /// GET /info "caps": per mint, each kind's { sym, amount (whole tokens), atoms, usd?, unpriced? }; totalShielded also
  /// carries room (atoms still admissible) when this relayer's publisher measured it in the last two minutes, else null.
  capsInfo() { if (!this.caps) return null; const out = { note: 'while Veyl is new' }; const toks = Object.keys(this.symOf).map((m) => this._capTok(m));
    for (const kind of C.KINDS) { if (!this.caps[kind]) continue; out[kind] = {};
      for (const t of toks) { const c = C.capOf(this.caps, kind, t); if (!c) continue; const e = { sym: t.sym, decimals: t.decimals, amount: c.amount, atoms: c.atoms.toString() }; if (c.usd) e.usd = c.usd; if (c.unpriced) e.unpriced = true;
        if (kind === 'totalShielded') { const r = this.capRoom[t.mint]; e.room = r && Date.now() - r.at < ROOM_FRESH_MS ? r.room.toString() : null; }
        out[kind][t.mint] = e; } }
    if (this.caps.perDeposit && this.caps.perDeposit['*']) out.perDepositUsd = this.caps.perDeposit['*']; if (this.caps.totalShielded && this.caps.totalShielded['*']) out.totalShieldedUsd = this.caps.totalShielded['*'];
    return out; }
  info() { const i = super.info(); i.caps = this.capsInfo(); return i; }
  /// Atoms of each mint already admitted to the shielded pool: its vault balance minus every pending deposit in that mint
  /// (the vault also holds the fee pot of unclaimed liquidity fees, so this errs high: never lets more in than the cap).
  /// Read (one balance each): the mints with a total cap and something pending, and with `all` every capped token it knows.
  async _shieldedNow(pending, pv, all = false) { const out = {}; if (!this.caps || !this.caps.totalShielded) return out; const pend = {};
    for (const d of pending) { const m = String(d.mint); pend[m] = (pend[m] || 0n) + BigInt(d.amount); }
    const mints = new Set([...Object.keys(pend), ...(all ? Object.keys(this.symOf) : [])]);
    for (const m of mints) { pend[m] = pend[m] || 0n; if (!C.capOf(this.caps, 'totalShielded', this._capTok(m))) continue; const mint = new PublicKey(m);
      let bal = 0n; try { bal = BigInt((await this.conn.getTokenAccountBalance(pv.shieldVault(mint, await pv.tokenProgram(mint)))).value.amount); } catch { /* no vault yet: nothing shielded */ }
      out[m] = bal > pend[m] ? bal - pend[m] : 0n; }
    return out; }
  /// After a pass: what each measured mint can still take (its total cap minus what is admitted now), for /info.
  _noteRoom(used) { for (const [m, u] of Object.entries(used)) { const c = C.capOf(this.caps, 'totalShielded', this._capTok(m)); if (c) this.capRoom[m] = { room: c.atoms > u ? c.atoms - u : 0n, at: Date.now() }; } }
  /// Phase 1: a deposit of `value` atoms into the private pool of `mint` is within the per-deposit cap.
  _underDepositCap(mint, value) { if (!this.caps) return true; const c = C.capOf(this.caps, 'perDeposit', this._capTok(mint)); return !c || (!c.unpriced && BigInt(value) <= c.atoms); }
};
module.exports.capsFromEnv = capsFromEnv;
