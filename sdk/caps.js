// Deposit caps while Veyl is new (it launches without an external audit): config/<network>.json "caps", in whole tokens.
//   { "perDeposit": { "USDC": 10000, "SOL": 100, "*": 1000 }, "totalShielded": { "USDC": 250000, "*": 25000 } }
// A symbol (or a mint) names one token. "*" is a cap in US dollars for every token not named, valued at the relayer's
// prices; while "*" is set, a token the relayer cannot value is not admitted at all. No "caps" (devnet, local): no limits.
// The approved-set publisher (relayer/postman.js) admits a pending shielded deposit only within them, oldest first; one it
// refuses stays pending, and its depositor can take it back at any time (cancel_deposit). Phase 1 deposits over the
// per-deposit cap are left out of the approved set (the depositor takes them back with ragequit).
// Shared by the relayer (enforces them, serves them at /info) and the browser engine (refuses up front, same words).
'use strict';
const KINDS = ['perDeposit', 'totalShielded'];
/// A "caps" object with only positive numbers kept (keys starting with "_" are comments), or null when nothing is capped.
function normCaps(c) { if (!c || typeof c !== 'object') return null; const out = {};
  for (const k of KINDS) { const o = {}; for (const [s, v] of Object.entries(c[k] || {})) if (!s.startsWith('_') && Number(v) > 0) o[s] = Number(v); if (Object.keys(o).length) out[k] = o; }
  return Object.keys(out).length ? out : null; }
const toAtoms = (human, decimals) => BigInt(Math.floor(Number(human) * 10 ** decimals + 1e-6));
/// The cap of `kind` for one token: { atoms (BigInt), amount (whole tokens), usd? , unpriced? } or null when uncapped.
/// tok = { sym, mint, decimals, usd } (usd: the relayer's price of one whole token, 0 when it has none).
function capOf(caps, kind, tok) { const o = caps && caps[kind]; if (!o) return null; const named = o[tok.sym] !== undefined ? o[tok.sym] : o[tok.mint];
  if (named !== undefined) return { atoms: toAtoms(named, tok.decimals), amount: named };
  if (o['*'] === undefined) return null; if (!(tok.usd > 0)) return { atoms: 0n, amount: 0, usd: o['*'], unpriced: true };
  const amount = Number((o['*'] / tok.usd).toPrecision(4)); return { atoms: toAtoms(amount, tok.decimals), amount, usd: o['*'] }; }
/// The publisher's decision for each pending deposit, in order: [{ d, ok, why: null | 'perDeposit' | 'totalShielded' | 'unpriced' }].
/// tokOf(mint) -> tok as above; shielded = { mint: atoms already admitted } (the vault minus every pending deposit).
function admitPlan(pending, caps, tokOf, shielded = {}) { const used = {}; for (const [m, v] of Object.entries(shielded)) used[m] = BigInt(v);
  return pending.map((d) => { const mint = String(d.mint), amt = BigInt(d.amount); if (!caps) return { d, ok: true, why: null }; const t = tokOf(mint);
    const per = capOf(caps, 'perDeposit', t); if (per && per.unpriced) return { d, ok: false, why: 'unpriced' }; if (per && amt > per.atoms) return { d, ok: false, why: 'perDeposit' };
    const tot = capOf(caps, 'totalShielded', t); if (tot && tot.unpriced) return { d, ok: false, why: 'unpriced' };
    if (tot) { const u = used[mint] || 0n; if (u + amt > tot.atoms) return { d, ok: false, why: 'totalShielded' }; used[mint] = u + amt; }
    return { d, ok: true, why: null }; }); }
const fmtH = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
/// The words a refused deposit gets, from the caps a relayer serves at /info (keyed by mint): a string, or null when
/// `atoms` of this token is within them. tok = { sym, mint, decimals }.
function capMessage(caps, tok, atoms) { if (!caps) return null; atoms = BigInt(atoms); const per = caps.perDeposit && caps.perDeposit[tok.mint], tot = caps.totalShielded && caps.totalShielded[tok.mint];
  if (per && per.unpriced) return 'While Veyl is new it only takes tokens it can price, and ' + tok.sym + ' is not one of them yet.';
  if (per && atoms > BigInt(per.atoms)) return 'Deposits are capped at ' + fmtH(per.amount) + ' ' + tok.sym + ' while Veyl is new.';
  if (tot && tot.room !== undefined && tot.room !== null && atoms > BigInt(tot.room)) { const room = Number(BigInt(tot.room)) / 10 ** tok.decimals;
    return room > 0 ? 'Veyl takes at most ' + fmtH(tot.amount) + ' ' + tok.sym + ' in total while it is new: up to ' + fmtH(room) + ' ' + tok.sym + ' more can go in right now.'
      : 'Veyl takes at most ' + fmtH(tot.amount) + ' ' + tok.sym + ' in total while it is new, and that is reached. Try again later.'; }
  return null; }
module.exports = { normCaps, capOf, admitPlan, capMessage, toAtoms, KINDS };
