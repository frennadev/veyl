// Who holds each privileged role of a deployment, read from the chain. Shared by `npm run handover` and preflight.
//   upgrade authority   x3 programs (ProgramData)              can replace the code: the strongest role
//   pool authority      per private pool (+ pending)           sets the postman, hands itself over
//   postman             per private pool                       publishes / resets the approved set (can freeze private exits)
//   factory authority   veyl_bin factory (+ pending)           fee tiers, listing bond, delists pools (bond -> treasury), farm rewards
//   protocol fee auth.  veyl_bin factory (+ pending)           withdraws the protocol fee (fixed 0.2% of every swap), sets the treasury
//   treasury            veyl_bin factory                       receives the bonds of delisted pools (an address, set by the fee authority)
//   reward funder       per bin pool and reward slot           funds emissions, takes back ineligible (undistributed) rewards
//   lookup table        relayer's address lookup table         can extend / deactivate it (cannot be transferred; freeze it)
//   committee authority veyl_entry committee (+ pending)       registers / rotates the batch committee's key, sets each sealed
//                       (Phase 3)                              pool's rules and can pause it (cannot decrypt anything)
'use strict';
const { PublicKey } = require('@solana/web3.js');

async function upgradeAuthority(conn, programId) {
  const acc = await conn.getAccountInfo(new PublicKey(programId)); if (!acc) return { exists: false };
  if (acc.data.length < 36) return { exists: true, authority: null, immutable: true };
  const pd = await conn.getAccountInfo(new PublicKey(acc.data.subarray(4, 36))); if (!pd) return { exists: true, authority: null };
  return { exists: true, programData: new PublicKey(acc.data.subarray(4, 36)).toBase58(), authority: pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null, immutable: pd.data[12] !== 1 };
}

/// [{ role, target, holder, pending }] for a deployment (deploy.<network>.json), all base58.
async function readRoles(V, dep) {
  const conn = V.conn; const out = []; const b58 = (k) => (k ? new PublicKey(k).toBase58() : null); const zero = PublicKey.default.toBase58();
  for (const [k, id] of Object.entries(dep.programs)) { const u = await upgradeAuthority(conn, id); out.push({ role: `upgrade authority (${k})`, kind: 'upgrade', target: id, holder: u.exists ? (u.immutable ? 'immutable' : u.authority) : 'not deployed' }); }
  for (const [sym, t] of Object.entries(dep.tokens || {})) { const p = await V.pool(t.pool); if (!p) { out.push({ role: `pool authority (${sym})`, kind: 'pool', target: t.pool, holder: 'missing' }); continue; }
    const pending = b58(p.pendingAuthority); out.push({ role: `pool authority (${sym})`, kind: 'pool', target: b58(t.pool), mint: t.mint, holder: b58(p.authority), pending: pending === zero ? null : pending });
    out.push({ role: `postman (${sym})`, kind: 'postman', target: b58(t.pool), holder: b58(p.postman) }); }
  const f = await V.factory(); if (f) { const pending = b58(f.pendingAuthority); out.push({ role: 'factory authority', kind: 'factory', target: V.factoryPda().toBase58(), holder: b58(f.authority), pending: pending === zero ? null : pending });
    const pf = b58(f.pendingFeeAuthority); out.push({ role: 'protocol fee authority', kind: 'fee', target: V.factoryPda().toBase58(), holder: b58(f.feeAuthority), pending: pf === zero ? null : pf });
    out.push({ role: 'treasury', kind: 'treasury', target: V.factoryPda().toBase58(), holder: b58(f.treasury) }); }
  for (const b of dep.binPools || []) { let p = null; try { p = await V.binPool(b.address); } catch { /* unreadable */ } if (!p) continue;
    p.rewards.forEach((r, i) => { if (r.initialized) out.push({ role: `reward funder (${b.id} #${i})`, kind: 'reward', target: b58(b.address), index: i, holder: b58(r.funder) }); }); }
  { require('../sdk/sealed.js'); let c = null; try { c = await V.committee(); } catch { /* not deployed */ }
    if (c) { const pending = b58(c.pendingAuthority); out.push({ role: 'committee authority', kind: 'committee', target: V.committeePda().toBase58(), holder: b58(c.authority), pending: pending === zero ? null : pending }); } }
  if (dep.lookupTable) { try { const t = (await conn.getAddressLookupTable(new PublicKey(dep.lookupTable))).value;
    out.push({ role: 'lookup table authority', kind: 'lut', target: dep.lookupTable, holder: t ? (t.state.authority ? t.state.authority.toBase58() : 'frozen') : 'missing' }); } catch { /* table unreadable */ } }
  return out;
}

/// Problems with the roles of a live deployment: anything still held by the deployer key, a postman that is the relayer's
/// hot wallet, handovers proposed but not accepted.
function roleFindings(roles, { deployer, relayer }) {
  const red = [], warn = [];
  for (const r of roles) {
    if (r.holder === deployer && r.kind !== 'lut') red.push(`${r.role} still held by the deployer`);
    if ((r.kind === 'postman' || r.kind === 'fee' || r.kind === 'treasury' || r.kind === 'reward') && relayer && r.holder === relayer) red.push(`${r.role} is the relayer's hot wallet`);
    if (r.pending) warn.push(`${r.role}: handover to ${r.pending.slice(0, 8)}… proposed, not accepted yet`);
    if (r.kind === 'lut' && r.holder === deployer) warn.push('lookup table authority is the deployer (it cannot be transferred: freeze it once the relayer works, npm run handover -- --freeze-lut)');
  }
  return { red, warn };
}
module.exports = { readRoles, roleFindings, upgradeAuthority };
