// Phase 1 program features, against the same local validator and deployment as tests/run.js (called from there, before the
// authority handover): bin bitmaps (sparse pools), Meteora-style fee accounting (fee growth per share, claimable fees,
// protocol share), limit orders, rebalancing, zaps, farm rewards, and the private variant of each through the entry
// program and the relayer service. Every check compares the chain with the JavaScript twin in sdk/veyl.js where there is
// maths to compare, and the property tests replay seeded random sequences.
'use strict';
const nacl = require('tweetnacl');
const { Keypair, PublicKey, Ed25519Program } = require('@solana/web3.js');
const S = require('../sdk/veyl.js');
const { Relayer } = require('../relayer/relayer.js');

const BIN_FIELDS = ['x', 'y', 'shares', 'feeGx', 'feeGy', 'askShares', 'askX', 'askFilledY', 'bidShares', 'bidY', 'bidFilledX'];
/// Seeded PRNG (mulberry32) so a failing property run can be replayed.
const prng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

module.exports = async function phase1(C) {
  const { conn, payer, V, as, alice, bob, carol, mallory, relayer, postman, dep, T, BP, check, refused, cuOf, CU, prove, fund, units, priceQ, sleep, lap, usdcLabels } = C;
  const { H, merklePath, withdrawInput, newNote, contextOf, encodeAction, ASP_DEPTH, Q } = S;
  const SOL = T.SOL.mint, USDC = T.USDC.mint, USDT = T.USDT.mint; const POOL_USDC = T.USDC.pool, POOL_SOL = T.SOL.pool, POOL_USDT = T.USDT.pool;
  const R = as(relayer); const EP = V.signerPda(); const J = (o) => JSON.parse(S.j(o));
  const nowS = () => Math.floor(Date.now() / 1000); const dl = () => nowS() + 900;
  const bal = (m, o) => V.tokenBalance(m, o);
  const amt = async (addr) => BigInt((await conn.getTokenAccountBalance(addr)).value.amount);
  const evOf = async (sig, name) => (await V.events(sig)).find((e) => e.name === name);
  const evsOf = async (sig, name) => (await V.events(sig)).filter((e) => e.name === name);
  const mkPool = async (binStep, baseFee = 500, vfc = 10_000) => { await V.send([await V.createPoolIx(payer.publicKey, SOL, USDT, binStep, baseFee, vfc, priceQ(150, 9, 6), 0)]); return V.binPoolPda(SOL, USDT, binStep); };
  const addLiq = async (kp, pool, ids, ax, ay, extra = {}) => { const pre = await V.ensureBinAccountsIxs(kp.publicKey, pool, ids, kp.publicKey, kp.publicKey); if (pre.length) await as(kp).send(pre, [], 400_000);
    return as(kp).send([await V.mintIx(kp.publicKey, pool, { ids, amountsX: ax, amountsY: ay, ...extra })], [], 1_400_000); };
  const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };
  /// Swap with the on-chain quote as minOut, and compare: on-chain quote == JS twin == executed swap, and every bin the twin
  /// touched (reserves, fee growth, limit orders) == the bin on chain afterwards.
  const swapChecked = async (kp, pool, xForY, amount, label) => {
    const p = await V.binPool(pool); const bins = await V.bins(pool, S.chunksForSwap(p, xForY)); const t = nowS();
    let ql, qc; try { ql = S.simulateSwap(p, bins, xForY, amount, t); } catch (e) { ql = { err: e.message }; }
    try { qc = await V.quote(pool, xForY, amount); } catch (e) { qc = { err: e.message }; }
    if (ql.err || qc.err) return { ok: !!ql.err && !!qc.err && qc.err.includes(ql.err), ql, qc, skipped: true };
    const sig = await as(kp).send([await V.swapIx(kp.publicKey, pool, xForY, amount, qc.out)], [], 1_400_000); if (label) await cuOf(conn, sig, label);
    const ev = await evOf(sig, 'Swapped');
    const after = await V.bins(pool, [...new Set(ql.touched.map((x) => S.chunkOf(x.id)))]);
    const same = ql.touched.every((tb) => BIN_FIELDS.every((f) => after.get(tb.id)[f] === tb[f]));
    const ok = qc.out === ql.out && qc.fee === ql.fee && qc.endId === ql.endId && ev.amountOut === qc.out && ev.fee === qc.fee && ev.activeId === qc.endId && ev.protocolFee === ql.protocolFee && same;
    if (!ok) console.log('    swap mismatch', S.j({ qc, out: ql.out, fee: ql.fee, endId: ql.endId, proto: ql.protocolFee, ev, same }).slice(0, 600));
    return { ok, ql, qc, ev, sig };
  };
  let sig, ev;

  // ======================================================================================== A. bitmap: sparse pools
  console.log('  -- phase 1: bitmaps, fees, protocol share, limit orders, rebalance, zap, rewards, private variants');
  const SP = await mkPool(7);
  // farm reward on a pool whose active bin is empty (its bin array does not even exist): all emission is ineligible
  check('rewards: only the factory authority sets up a reward slot', await refused(as(mallory).send([await V.initRewardIx(mallory.publicKey, SP, 0, USDT, 3600, mallory.publicKey)]), /NotAuthority|ConstraintHasOne/));
  await V.send([await V.initRewardIx(payer.publicKey, SP, 0, USDT, 3600, payer.publicKey)]);
  await fund(conn, payer, USDT, payer.publicKey, units(20_000, 6));
  check('rewards: only the reward funder funds it', await refused(as(mallory).send([await V.fundRewardIx(mallory.publicKey, SP, 0, units(1, 6), V.ata(USDT, mallory.publicKey))]), /NotAuthority/));
  sig = await V.send([await V.fundRewardIx(payer.publicKey, SP, 0, units(3600, 6))]); ev = await evOf(sig, 'RewardFunded');
  check('rewards: fund_reward sets rate = amount / duration per second (Q64.64) and the end', ev && ev.rateQ64 === (units(3600, 6) << 64n) / 3600n && (await V.binPool(SP)).rewards[0].initialized);
  // liquidity far from the active bin: Y at -700 and -1500, X at +900 (arrays -12, -25, 15; the active bin's array 0 never created)
  sig = await addLiq(alice, SP, [-1500, -700, 900], [0n, 0n, units(2, 9)], [units(300, 6), units(300, 6), 0n]);
  let p = await V.binPool(SP);
  check('A bitmaps: the pool marks arrays -25 and -12 as holding Y, 15 as holding X, nothing else', S.liveChunks(p, true).join() === '-25,-12' && S.liveChunks(p, false).join() === '15');
  await sleep(2500);
  { const before = (await V.binPool(SP)).rewards[0]; sig = await V.send([await V.withdrawIneligibleRewardIx(payer.publicKey, SP, 0)]); const after = (await V.binPool(SP)).rewards[0]; ev = await evOf(sig, 'IneligibleRewardWithdrawn');
    check('rewards: emission while the active bin has no liquidity provider is ineligible; the funder takes exactly rate x elapsed back', ev && ev.amount === (after.lastUpdate - before.lastUpdate) * units(1, 6) + before.ineligible && ev.amount > 0n && after.ineligible === 0n, String(ev && ev.amount));
    check('rewards: nobody else can withdraw ineligible rewards', await refused(as(mallory).send([await V.withdrawIneligibleRewardIx(mallory.publicKey, SP, 0, V.ata(USDT, mallory.publicKey))]), /NotAuthority/)); }
  let r = await swapChecked(bob, SP, true, units(5, 9), 'swap (sparse: 2 bins, 1,500 empty skipped)');
  check('A sparse pool: one swap jumps 699 then 799 empty bins (the old walk stopped at 256 steps); on-chain quote == JS twin == executed, touched bins identical', r.ok && r.ev.activeId === -1500 && r.ql.touched.length === 2, `out ${r.ev && r.ev.amountOut}`);
  p = await V.binPool(SP);
  check('A bitmaps follow the swap: array -12 now holds X only (its bin was drained of Y), -25 still holds Y', !S.chunkBit(p, true, -12) && S.chunkBit(p, false, -12) && S.chunkBit(p, true, -25) && S.chunkBit(p, false, 15));
  r = await swapChecked(bob, SP, false, units(600, 6), 'swap (sparse: 3 bins up)');
  check('A back up: buys the X at -1500, -700 and +900 (2,400 bins apart), twin == chain', r.ok && r.ev.activeId === 900 && r.ql.touched.length === 3);
  // property: seeded random swaps both ways; either everything matches or quote and twin fail with the same error
  { const rnd = prng(1); let good = true, n = 0, fails = 0;
    for (let i = 0; i < 12; i++) { const xForY = rnd() < 0.5; const a = xForY ? BigInt(Math.floor(rnd() * 1.5e9)) + 1n : BigInt(Math.floor(rnd() * 250e6)) + 1n;
      const s = await swapChecked(i % 2 ? carol : bob, SP, xForY, a); good = good && s.ok; n++; if (s.skipped) fails++; }
    check(`A property (seed 1, ${n} random swaps over a sparse pool): every quote == twin == executed with identical bins, or both refuse alike`, good, `${fails} refused alike`); }

  // ======================================================================================== B. fee accounting, protocol fee, conservation
  const CP = await mkPool(9); const cpIds = range(-3, 3);
  for (const [kp, k] of [[alice, 1n], [bob, 2n], [carol, 3n]]) await addLiq(kp, CP, cpIds, cpIds.map((i) => (i >= 0 ? (k * units(1, 9)) / 2n : 0n)), cpIds.map((i) => (i <= 0 ? k * units(75, 6) : 0n)));
  p = await V.binPool(CP);
  check('B a new pool takes the default protocol share (10%) and accounts nothing yet', p.protocolShare === 1000 && p.protocolFeeX === 0n && p.protocolFeeY === 0n);
  const vault0 = { x: await amt(p.vaultX), y: await amt(p.vaultY) };
  let fees = { x: 0n, y: 0n }, proto = { x: 0n, y: 0n }, touches = 0n, allOk = true;
  { const rnd = prng(7);
    for (let i = 0; i < 14; i++) { const xForY = rnd() < 0.5; const a = xForY ? BigInt(Math.floor(rnd() * 0.9e9)) + 1000n : BigInt(Math.floor(rnd() * 130e6)) + 1000n;
      const s = await swapChecked([bob, carol, mallory][i % 3], CP, xForY, a, i === 0 ? 'swap (fee split, 1 bin)' : undefined); allOk = allOk && s.ok && !s.skipped;
      if (s.ev) { if (xForY) { fees.x += s.ev.fee; proto.x += s.ev.protocolFee; } else { fees.y += s.ev.fee; proto.y += s.ev.protocolFee; } touches += BigInt(s.ql.touched.length); } } }
  p = await V.binPool(CP);
  check('B property (seed 7, 14 random swaps): every swap == twin, including each touched bin\'s fee growth per share', allOk);
  check('B fees are accounted, not folded into the reserves: protocol balance == the 10% share of every fee, lifetime totals == the fees', p.protocolFeeX === proto.x && p.protocolFeeY === proto.y && p.totalFeeX === fees.x && p.totalFeeY === fees.y && proto.x > 0n && proto.y > 0n && proto.x <= fees.x / 10n && proto.x >= fees.x / 10n - touches);
  // every LP claims what the SDK shows unclaimed
  const claimed = { x: 0n, y: 0n }; let exact = true; const per = [];
  for (const kp of [alice, bob, carol]) { const pos = await V.position(CP, kp.publicKey, kp.publicKey, cpIds);
    sig = await as(kp).send([await V.claimFeesIx(kp.publicKey, CP, { ids: cpIds })], [], 600_000); if (kp === alice) await cuOf(conn, sig, 'claim_fees (7 bins)');
    ev = await evOf(sig, 'FeesClaimed'); exact = exact && ev.amountX === pos.fees.x && ev.amountY === pos.fees.y && pos.fees.x + pos.fees.y > 0n; claimed.x += ev.amountX; claimed.y += ev.amountY; per.push(ev.amountX + ev.amountY * 6n); }
  check('B claim_fees pays each LP exactly the unclaimed fees the SDK computes (position())', exact, `claimed ${claimed.x} lamports, ${claimed.y} USDT atoms`);
  check('B fees are shared pro rata to liquidity: bob (2x alice) and carol (3x) claimed 2x and 3x alice\'s fees, within 1%', Math.abs(Number(per[1]) / Number(per[0]) - 2) < 0.02 && Math.abs(Number(per[2]) / Number(per[0]) - 3) < 0.03, per.map(String).join(' / '));
  { const dx = fees.x - proto.x - claimed.x, dy = fees.y - proto.y - claimed.y; const bound = 3n * BigInt(cpIds.length) + 1n;
    check('B fee conservation: fees paid in == fees claimed + protocol fees + floor dust kept by the pool (0 <= dust < 1 atom per LP per bin)', dx >= 0n && dy >= 0n && dx <= bound && dy <= bound, `dust ${dx} / ${dy} atoms`);
    const bins = await V.bins(CP, [-1, 0, 1, -2]); let sx = 0n, sy = 0n; for (const b of bins.values()) { sx += b.x + b.askX + b.bidFilledX; sy += b.y + b.bidY + b.askFilledY; }
    const vx = await amt(p.vaultX), vy = await amt(p.vaultY);
    check('B vault == bin reserves + protocol fees + that dust, to the atom (after every LP claimed)', vx - sx - p.protocolFeeX === dx && vy - sy - p.protocolFeeY === dy && vault0.x > 0n); }
  sig = await as(alice).send([await V.claimFeesIx(alice.publicKey, CP, { ids: cpIds })], [], 600_000); ev = await evOf(sig, 'FeesClaimed');
  check('B claiming again right away pays nothing', ev.amountX === 0n && ev.amountY === 0n);
  await fund(conn, payer, SOL, payer.publicKey, 0n);
  { const ix = await V.claimFeesIx(mallory.publicKey, CP, { owner: alice.publicKey, ids: cpIds }); ix.keys.splice(ix.keys.length - 2, 2, ...V.binRemaining(CP, cpIds, alice.publicKey, alice.publicKey).slice(-2));
    check('B a stranger cannot claim alice\'s fees (her share accounts name her as authority)', await refused(as(mallory).send([ix], [], 600_000), /WrongShareAccount|MissingShareAccount/)); }
  // protocol share and protocol fee withdrawal: fee authority only
  check('B protocol share above 25% is refused', await refused(V.send([V.setProtocolShareIx(payer.publicKey, CP, 2501)]), /BadParams/));
  check('B only the protocol fee authority sets the share', await refused(as(mallory).send([V.setProtocolShareIx(mallory.publicKey, CP, 0)]), /NotAuthority|ConstraintHasOne/));
  sig = await V.send([V.setProtocolShareIx(payer.publicKey, CP, 2500)]); ev = await evOf(sig, 'ProtocolShareSet');
  r = await swapChecked(bob, CP, true, units(0.3, 9));
  check('B at 25% the protocol takes a quarter of each bin\'s fee (twin == chain)', ev && ev.bps === 2500 && r.ok && r.ev.protocolFee >= r.ev.fee / 4n - BigInt(r.ql.touched.length) && r.ev.protocolFee <= r.ev.fee / 4n);
  await V.send([V.setProtocolShareIx(payer.publicKey, CP, 1000)]);
  p = await V.binPool(CP);
  check('B a stranger cannot withdraw protocol fees', await refused(as(mallory).send([await V.withdrawProtocolFeeIx(mallory.publicKey, CP, 1n, 0n, V.ata(SOL, mallory.publicKey), V.ata(USDT, mallory.publicKey))]), /NotAuthority|ConstraintHasOne/));
  check('B the fee authority cannot withdraw more than is accounted', await refused(V.send([await V.withdrawProtocolFeeIx(payer.publicKey, CP, p.protocolFeeX + 1n, 0n)]), /NotEnoughFees/));
  { const sx = await bal(SOL, payer.publicKey), sy = await bal(USDT, payer.publicKey); sig = await V.send([await V.withdrawProtocolFeeIx(payer.publicKey, CP, p.protocolFeeX, p.protocolFeeY)]); await cuOf(conn, sig, 'withdraw_protocol_fee');
    const q = await V.binPool(CP); check('B the fee authority withdraws the accounted protocol fees (both tokens); the balance goes to zero', (await bal(SOL, payer.publicKey)) - sx === p.protocolFeeX && (await bal(USDT, payer.publicKey)) - sy === p.protocolFeeY && q.protocolFeeX === 0n && q.protocolFeeY === 0n); }
  // burn returns reserves only; fees earned meanwhile stay claimable
  r = await swapChecked(carol, CP, false, units(40, 6)); r = await swapChecked(carol, CP, true, units(0.3, 9));
  { const pos = await V.position(CP, alice.publicKey, alice.publicKey, cpIds); const b0 = await V.bins(CP, [-1, 0]); const s0 = (await V.shareAccount(CP, alice.publicKey, alice.publicKey, 0)).slots[0].shares; const v = V.valueOf(b0.get(0), s0 / 2n);
    sig = await as(alice).send([await V.burnIx(alice.publicKey, CP, { ids: [0], shares: [s0 / 2n] })], [], 600_000); ev = await evOf(sig, 'Burned');
    const pos2 = await V.position(CP, alice.publicKey, alice.publicKey, cpIds);
    check('B burn pays the reserves only (== valueOf); the fees earned stay claimable, unchanged', ev.amountX === v.x && ev.amountY === v.y && pos2.fees.x === pos.fees.x && pos2.fees.y === pos.fees.y && pos.fees.x + pos.fees.y > 0n); }

  // ======================================================================================== C. limit orders
  const LO = await mkPool(11);
  await addLiq(alice, LO, range(-2, 5), range(-2, 5).map((i) => (i >= 0 ? units(0.5, 9) : 0n)), range(-2, 5).map((i) => (i <= 0 ? units(75, 6) : 0n)));
  await as(bob).send(await V.ensureBinAccountsIxs(bob.publicKey, LO, [3], bob.publicKey, bob.publicKey)); await as(carol).send(await V.ensureBinAccountsIxs(carol.publicKey, LO, [-4], carol.publicKey, carol.publicKey));
  check('C an ask must sit above the active bin, a bid below it (WrongSide: the placement guard)', await refused(as(bob).send([await V.placeOrderIx(bob.publicKey, LO, { id: -1, isAsk: true, amount: units(1, 9) })]), /WrongSide/) && await refused(as(carol).send([await V.placeOrderIx(carol.publicKey, LO, { id: 0, isAsk: false, amount: units(1, 6) })]), /WrongSide/));
  sig = await as(bob).send([await V.placeOrderIx(bob.publicKey, LO, { id: 3, isAsk: true, amount: units(1, 9) })], [], 400_000); await cuOf(conn, sig, 'place_limit_order'); ev = await evOf(sig, 'LimitOrderPlaced');
  await as(carol).send([await V.placeOrderIx(carol.publicKey, LO, { id: -4, isAsk: false, amount: units(150, 6) })], [], 400_000);
  let b3 = (await V.bins(LO, [0])).get(3);
  check('C ask placed: bin 3 holds 1 SOL of orders apart from its market-making X; the first order\'s shares == its amount', ev && ev.shares === units(1, 9) && b3.askX === units(1, 9) && b3.x === units(0.5, 9));
  r = await swapChecked(carol, LO, false, units(500, 6), 'swap (through a limit order)');
  b3 = (await V.bins(LO, [0])).get(3); const price3 = S.priceOf((await V.binPool(LO)).basePrice, 11, 3);
  check('C the swap up through bin 3 fills the ask: nothing unfilled, the filled Y = its share of the input + its fee share (twin == chain)', r.ok && r.ev.activeId > 3 && b3.askX === 0n && b3.askFilledY > S.mulDiv(units(1, 9), price3, Q), `filled ${b3.askFilledY} vs ${S.mulDiv(units(1, 9), price3, Q)} at the bin price`);
  let posB = await V.position(LO, bob.publicKey, bob.publicKey, [3]);
  check('C the SDK shows bob\'s order as filled', posB.orders.length === 1 && posB.orders[0].filled && posB.orders[0].filledY === b3.askFilledY);
  r = await swapChecked(bob, LO, true, units(3, 9));
  const b3b = (await V.bins(LO, [0])).get(3);
  check('C the price comes back down through bin 3: the order stays filled (no un-fill, unlike a range position)', r.ok && r.ev.activeId < 3 && b3b.askX === 0n && b3b.askFilledY === b3.askFilledY);
  check('C a stranger cannot withdraw bob\'s order', await refused(as(mallory).send([await V.withdrawOrderIx(mallory.publicKey, LO, { owner: bob.publicKey, id: 3, isAsk: true, shares: 1n })], [], 400_000), /MissingShareAccount|WrongShareAccount/));
  { const y0 = await bal(USDT, bob.publicKey); sig = await as(bob).send([await V.withdrawOrderIx(bob.publicKey, LO, { id: 3, isAsk: true, shares: posB.orders[0].shares })], [], 400_000); await cuOf(conn, sig, 'withdraw_limit_order'); ev = await evOf(sig, 'LimitOrderWithdrawn');
    check('C bob withdraws after the fill: all Y (the converted order + its fees), no X', ev.amountX === 0n && ev.amountY === b3.askFilledY && (await bal(USDT, bob.publicKey)) - y0 === b3.askFilledY); }
  // a partial fill of carol's bid at -4: find (with the twin) a swap that ends inside bin -4
  { const pl = await V.binPool(LO); const bins = await V.bins(LO, S.chunksForSwap(pl, true)); let a = units(0.05, 9), sim = null;
    for (let i = 0; i < 80; i++) { try { sim = S.simulateSwap(pl, bins, true, a, nowS()); } catch { sim = null; } if (sim && sim.endId === -4) break; a += units(0.05, 9); }
    r = await swapChecked(mallory, LO, true, a);
    const b4 = (await V.bins(LO, [-1])).get(-4);
    check('C a partial fill: carol\'s bid is now part Y (unfilled), part X (filled), as the twin says', r.ok && r.ev.activeId === -4 && b4.bidY > 0n && b4.bidY < units(150, 6) && b4.bidFilledX > 0n);
    const sh = (await V.position(LO, carol.publicKey, carol.publicKey, [-4])).orders[0].shares; sig = await as(carol).send([await V.withdrawOrderIx(carol.publicKey, LO, { id: -4, isAsk: false, shares: sh / 2n })], [], 400_000); ev = await evOf(sig, 'LimitOrderWithdrawn');
    check('C withdrawing half the order pays half of each part (floor), the rest stays working', ev.amountX === S.mulDiv(b4.bidFilledX, sh / 2n, b4.bidShares) && ev.amountY === S.mulDiv(b4.bidY, sh / 2n, b4.bidShares) && ev.unfilledLeft === b4.bidY - ev.amountY); }

  { const pl = await V.binPool(LO); const bins = await V.bins(LO, [-1, 0]); let sx = 0n, sy = 0n; for (const b of bins.values()) { sx += b.x + b.askX + b.bidFilledX; sy += b.y + b.bidY + b.askFilledY; }
    const posA = await V.position(LO, alice.publicKey, alice.publicKey, range(-2, 5)); const dx = (await amt(pl.vaultX)) - sx - pl.protocolFeeX - posA.fees.x, dy = (await amt(pl.vaultY)) - sy - pl.protocolFeeY - posA.fees.y;
    check('C conservation with limit orders: vault == market-making reserves + orders (unfilled, and filled incl. their fee share) + protocol fees + unclaimed LP fees + floor dust (0 <= dust <= 1 atom per bin)', dx >= 0n && dy >= 0n && dx <= 9n && dy <= 9n, `dust ${dx} / ${dy}`); }

  // ======================================================================================== D. rebalance (public)
  { const pr0 = await V.binPool(CP); const a0 = pr0.activeId; const sa = {}; for (const c of [-1, 0]) sa[c] = await V.shareAccount(CP, alice.publicKey, alice.publicKey, c);
    const burnIds = cpIds.filter((id) => sa[S.chunkOf(id)].slots[S.slotOf(id)].shares > 0n); const burnShares = burnIds.map((id) => sa[S.chunkOf(id)].slots[S.slotOf(id)].shares);
    const newIds = range(a0 - 5, a0 + 5); const { weightsX, weightsY } = S.shapeWeights(newIds, a0, 'curve');
    // the twin: burn, distribute by weights, shares per bin in order
    const bins = await V.bins(CP, [...new Set([...burnIds, ...newIds].map(S.chunkOf))]); let ox = 0n, oy = 0n;
    burnIds.forEach((id, i) => { const b = { ...bins.get(id) }; const vx = S.mulDiv(b.x, burnShares[i], b.shares), vy = S.mulDiv(b.y, burnShares[i], b.shares); ox += vx; oy += vy; b.x -= vx; b.y -= vy; b.shares -= burnShares[i]; bins.set(id, b); });
    const sw = S.sideWeights(newIds, weightsX, weightsY, a0); const ax = S.distribute(ox, sw.weightsX), ay = S.distribute(oy, sw.weightsY); const fee = await V.currentFee(CP);
    const expect = newIds.map((id, i) => { const s = ax[i] === 0n && ay[i] === 0n ? 0n : S.sharesForMint(pr0, bins.get(id) || S.EMPTY_BIN, id, a0, ax[i], ay[i], fee); const b = { ...(bins.get(id) || S.EMPTY_BIN) }; b.x += ax[i]; b.y += ay[i]; b.shares += s + (b.shares === 0n && s > 0n ? S.MIN_LIQUIDITY : 0n); bins.set(id, b); return s; });
    const fees0 = await V.position(CP, alice.publicKey, alice.publicKey, cpIds);
    await as(alice).send(await V.ensureBinAccountsIxs(alice.publicKey, CP, newIds, alice.publicKey, alice.publicKey), [], 400_000);
    check('D rebalance: min_shares one above what a bin gives is refused (TooFewShares) and nothing moves', await refused(as(alice).send([await V.rebalanceIx(alice.publicKey, CP, { burnIds, burnShares, ids: newIds, weightsX, weightsY, minShares: expect.map((x, i) => (i === 5 ? x + 1n : x)) })], [], 1_400_000), /TooFewShares/));
    check('D a stranger cannot rebalance alice\'s position', await refused(as(mallory).send([await V.rebalanceIx(mallory.publicKey, CP, { owner: alice.publicKey, burnIds, burnShares, ids: newIds, weightsX, weightsY })], [], 1_400_000), /MissingShareAccount|WrongShareAccount/));
    const sx0 = await bal(SOL, alice.publicKey), sy0 = await bal(USDT, alice.publicKey);
    sig = await as(alice).send([await V.rebalanceIx(alice.publicKey, CP, { burnIds, burnShares, ids: newIds, weightsX, weightsY, minShares: expect })], [], 1_400_000); await cuOf(conn, sig, `rebalance_position (${burnIds.length} -> ${newIds.length} bins)`); ev = await evOf(sig, 'Rebalanced');
    check(`D rebalance ${burnIds.length} bins -> ${newIds.length} (curve) in one instruction: every token burned is re-added, shares per bin == the twin`, ev && ev.burnedX === ox && ev.burnedY === oy && ev.readdedX === ox && ev.readdedY === oy && ev.shares.every((s, i) => s === expect[i]) && (await bal(SOL, alice.publicKey)) === sx0 && (await bal(USDT, alice.publicKey)) === sy0);
    const fees1 = await V.position(CP, alice.publicKey, alice.publicKey, [...cpIds, ...newIds]);
    check('D fees earned before the rebalance stay claimable (settled into the position)', fees1.fees.x === fees0.fees.x && fees1.fees.y === fees0.fees.y);
    // a side with no weights is paid out
    const cur = newIds.map((id) => fees1.bins.find((b) => b.id === id)); const yIds = newIds.filter((id) => id <= a0);
    const w2 = S.shapeWeights(yIds, a0, 'spot'); const sx1 = await bal(SOL, alice.publicKey);
    sig = await as(alice).send([await V.rebalanceIx(alice.publicKey, CP, { burnIds: newIds, burnShares: cur.map((b) => b.shares), ids: yIds, weightsX: yIds.map(() => 0), weightsY: w2.weightsY })], [], 1_400_000); ev = await evOf(sig, 'Rebalanced');
    check('D rebalance into Y only: the X side (no weights) is paid out to alice, the Y side re-added', ev.readdedX === 0n && ev.readdedY === ev.burnedY && (await bal(SOL, alice.publicKey)) - sx1 === ev.burnedX && ev.burnedX > 0n); }

  // ======================================================================================== E. zap (public)
  { const a = (await V.binPool(CP)).activeId; const ids = range(a - 3, a + 3); const w = S.shapeWeights(ids, a, 'spot'); const amountIn = units(300, 6);
    const plan = await V.planZap(CP, { xIn: false, amountIn, ids, ...w, slippageBps: 100 });
    await as(bob).send(await V.ensureBinAccountsIxs(bob.publicKey, CP, ids, bob.publicKey, bob.publicKey), [], 400_000);
    check('E zap: a swap output below min_swap_out is refused (Slippage)', await refused(as(bob).send([await V.swapAndAddIx(bob.publicKey, CP, { xIn: false, amountIn, swapAmount: plan.swapAmount, minSwapOut: plan.swapOut + 1n, ids, ...w, minShares: plan.minShares })], [], 1_400_000), /Slippage/));
    const y0 = await bal(USDT, bob.publicKey), x0 = await bal(SOL, bob.publicKey);
    sig = await as(bob).send([await V.swapAndAddIx(bob.publicKey, CP, { xIn: false, amountIn, swapAmount: plan.swapAmount, minSwapOut: plan.minSwapOut, ids, ...w, minShares: plan.minShares })], [], 1_400_000); await cuOf(conn, sig, 'swap_and_add (7 bins)');
    ev = await evOf(sig, 'ZapAdded');
    check('E zap 300 USDT into 7 bins: part swapped through the pool itself, everything added; output and shares per bin == the twin\'s plan; no leftover', ev && ev.swapAmount === plan.swapAmount && ev.swapOut === plan.swapOut && ev.shares.every((s, i) => s === plan.expectedShares[i]) && y0 - (await bal(USDT, bob.publicKey)) === amountIn && (await bal(SOL, bob.publicKey)) === x0, `swap ${plan.swapAmount} -> ${plan.swapOut}`); }

  // ======================================================================================== F. farm rewards
  { await V.send([await V.initRewardIx(payer.publicKey, CP, 0, USDT, 100, payer.publicKey)]);
    sig = await V.send([await V.fundRewardIx(payer.publicKey, CP, 0, units(100, 6))]); await cuOf(conn, sig, 'fund_reward');
    const a = (await V.binPool(CP)).activeId; await addLiq(mallory, CP, [a + 12], [units(0.2, 9)], [0n]); // far from the active bin
    await sleep(3500);
    const lps = [[alice, range(a - 9, a + 9)], [bob, range(a - 9, a + 9)], [carol, cpIds]]; let exactR = true;
    for (const [kp, ids0] of lps) { const ids = [...new Set(ids0)];
      const before = {}; for (const c of [...new Set(ids.map(S.chunkOf))]) before[c] = await V.shareAccount(CP, kp.publicKey, kp.publicKey, c);
      sig = await as(kp).send([await V.claimRewardIx(kp.publicKey, CP, { index: 0, ids: ids.filter((id) => before[S.chunkOf(id)]) })], [], 1_400_000); if (kp === alice) await cuOf(conn, sig, 'claim_reward');
      ev = await evOf(sig, 'RewardClaimed'); let expect = 0n;
      for (const c of Object.keys(before)) { const b = before[c]; if (!b) continue; const af = await V.shareAccount(CP, kp.publicKey, kp.publicKey, Number(c)); expect += b.pendingReward[0];
        b.slots.forEach((sl, i) => { if (ids.includes(Number(c) * S.BINS_PER_ARRAY + i)) expect += S.owedOf(af.slots[i].rewardCp[0], sl.rewardCp[0], sl.shares); }); }
      exactR = exactR && ev.amount === expect; }
    check('F claim_reward pays each LP exactly (growth since its checkpoint) x shares + its settled balance', exactR);
    sig = await as(mallory).send([await V.claimRewardIx(mallory.publicKey, CP, { index: 0, ids: [a + 12] })], [], 600_000); ev = await evOf(sig, 'RewardClaimed');
    check('F only the active bin earns: an LP whose only bin is 12 away earned nothing', ev.amount === 0n);
    // conservation: one transaction claims for all three (one timestamp), then everything emitted is accounted
    const t0 = (await V.binPool(CP)).rewards[0]; const tFund = t0.end - 100n;
    const ixs = []; for (const [kp] of lps) ixs.push(await V.claimRewardIx(kp.publicKey, CP, { index: 0, ids: [a] })); // only the active bin earns (no swap since funding)
    const tx = await V.tx(ixs, payer.publicKey, 1_400_000); tx.sign(payer, alice, bob, carol); sig = await conn.sendRawTransaction(tx.serialize()); await conn.confirmTransaction(sig, 'confirmed');
    const all = (await (async () => { let s = 0n; const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); for (const e of S.parseEvents(t.meta.logMessages)) if (e.name === 'RewardClaimed') s += e.amount; return s; })());
    const t1 = (await V.binPool(CP)).rewards[0];
    const vaultLeft = await amt(t1.vault); const emitted = (t1.lastUpdate - tFund) * units(1, 6);
    const paid = units(100, 6) - vaultLeft;
    check('F reward conservation: everything emitted so far (rate x elapsed) == paid to LPs + ineligible + floor dust (<= 1 atom per position update)', t1.ineligible === 0n && paid <= emitted && emitted - paid <= 12n && all > 0n, `emitted ${emitted}, paid ${paid}`); }

  // ======================================================================================== G. private variants (proofs and one-time keys)
  const svcLow = new Relayer({ connection: conn, wallet: relayer, deploy: dep, feeCover: 0.0005 }); // the same service with a cost floor at 0.05% of the real one (test amounts are small)
  const svc = new Relayer({ connection: conn, wallet: relayer, deploy: dep });
  const BPX = BP.find((b) => b.id === 'sol-usdc').address;
  // farm reward on SOL/USDC paid in USDT (which has a private pool: the reward can go into a note)
  await V.send([await V.initRewardIx(payer.publicKey, BPX, 0, USDT, 600, payer.publicKey)]); await V.send([await V.fundRewardIx(payer.publicKey, BPX, 0, units(600, 6))]);
  // two fresh USDC notes for alice (approved by the publisher)
  const notes = []; for (const v of [150, 300]) { const n = newNote(); sig = await as(alice).send([await V.depositIx(alice.publicKey, USDC, units(v, 6), n.precommitment)]); ev = await evOf(sig, 'Deposited'); notes.push({ ...n, value: ev.value.toString(), label: ev.label.toString(), index: Number(ev.index) }); }
  const labels = [...usdcLabels, ...notes.map((n) => BigInt(n.label))]; await as(postman).send([V.updateAspRootIx(postman.publicKey, POOL_USDC, merklePath(labels, 0, ASP_DEPTH).root, 'bafy-p1')]);
  const proofFor = async (note, kind, d) => { const leaves = (await V.readTree(POOL_USDC)).leaves; const w = withdrawInput({ note, withdrawnValue: BigInt(note.value), context: contextOf(EP, encodeAction(kind, d), POOL_USDC), leaves, labels }); const pr = await prove(w.input); return { proof: pr.proof.toString('base64'), pubs: pr.pubs.map(String) }; };
  const emptyEntry = async () => (await bal(USDC, EP)) === 0n && (await bal(SOL, EP)) === 0n && (await bal(USDT, EP)) === 0n;

  // G1. private limit order (a bid in USDC) from a note, through the relayer service
  const ok1 = Keypair.generate(); let bpx = await V.binPool(BPX); const oid = bpx.activeId - 3;
  let od = { binPool: BPX, id: oid, isAsk: false, owner: ok1.publicKey, feeRecipient: relayer.publicKey, feeBps: 0, deadline: dl() };
  check('relayer: /fee prices a private order; refuses one whose fee could not cover the relayer within the 1% cap', await refused(svc.feeQuote(J({ kind: 'order', d: od, legs: [{ mint: USDC, value: units(1, 6) }] })), /too small/));
  od.feeBps = (await svcLow.feeQuote(J({ kind: 'order', d: od, legs: [{ mint: USDC, value: notes[0].value }] }))).feeBps;
  check('relayer: a fee above its range (1% on-chain cap) is refused before anything is sent', await refused(svcLow.submit(J({ kind: 'order', d: { ...od, feeBps: 101 }, legs: [{ mint: USDC, p: { proof: Buffer.alloc(256).toString('base64'), pubs: ['1', '2', '3', '4', '5', '6'] } }] })), /fee out of range/));
  console.log('  proving (private order)...');
  let res = await svcLow.submit(J({ kind: 'order', d: od, legs: [{ mint: USDC, p: await proofFor(notes[0], 'order', od) }] })); await cuOf(conn, res.txHash, 'private_place_order (proof spent + order)');
  ev = await evOf(res.txHash, 'PrivateOrderPlaced'); const v1 = BigInt(notes[0].value); const net1 = v1 - (v1 * BigInt(od.feeBps)) / 10_000n;
  check('G private_place_order: a 150 USDC note -> a bid 3 bins under the active bin, owned by a one-time key (authority = the entry\'s signer), minus the relayer fee', ev && ev.amount === net1 && ev.shares > 0n && (await emptyEntry()), `${od.feeBps} bps`);
  // fill it
  { let a = units(1, 9), sim = null; const pl = await V.binPool(BPX); const bins = await V.bins(BPX, S.chunksForSwap(pl, true));
    for (let i = 0; i < 60; i++) { try { sim = S.simulateSwap(pl, bins, true, a, nowS()); } catch { sim = null; } if (sim && sim.endId < oid) break; a += units(1, 9); }
    r = await swapChecked(bob, BPX, true, a); }
  let posO = await V.position(BPX, ok1.publicKey, EP, [oid]);
  check('G a public swap fills the private bid (twin == chain); the SDK shows it filled', r.ok && posO.orders[0].filled && posO.orders[0].filledX > 0n);
  // G2. withdraw it privately: signed by the one-time key, into a new SOL note
  const nX = newNote(), nY = newNote();
  let wd = { owner: ok1.publicKey, binPool: BPX, id: oid, isAsk: false, shares: posO.orders[0].shares, precommitX: BigInt(nX.precommitment), precommitY: BigInt(nY.precommitment), recipient: null, feeRecipient: relayer.publicKey, feeBps: 0, nonce: 0n, deadline: dl() };
  wd.feeBps = (await svcLow.feeQuote(J({ kind: 'orderWithdraw', d: wd }))).feeBps;
  check('G private_withdraw_order without the ed25519 instruction is refused', await refused(R.sendV0([await V.privateWithdrawOrderIx(relayer.publicKey, wd)], [], 1_400_000), /BadSignature/));
  check('G ...signed by another key is refused', await refused(R.sendV0([V.signedSigIx('orderWithdraw', mallory.publicKey, V.signAction('orderWithdraw', mallory.secretKey, wd), wd), await V.privateWithdrawOrderIx(relayer.publicKey, wd)], [], 1_400_000), /BadSignature/));
  { const asRemove = S.signedDigest('remove', V.programs.entry, { owner: ok1.publicKey, binPool: BPX, ids: [oid], shares: [wd.shares], precommitX: wd.precommitX, precommitY: wd.precommitY, recipient: null, feeRecipient: relayer.publicKey, feeBps: wd.feeBps, nonce: 0n, deadline: wd.deadline });
    const sigIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: ok1.publicKey.toBytes(), message: asRemove, signature: nacl.sign.detached(asRemove, ok1.secretKey) });
    check('G ...a valid signature over a removal digest cannot withdraw an order (each action has its own domain tag)', await refused(R.sendV0([sigIx, await V.privateWithdrawOrderIx(relayer.publicKey, wd)], [], 1_400_000), /BadSignature/)); }
  res = await svcLow.submit(J({ kind: 'orderWithdraw', d: wd, sig: V.signAction('orderWithdraw', ok1.secretKey, wd).toString('base64') })); await cuOf(conn, res.txHash, 'private_withdraw_order');
  { const evs = await V.events(res.txHash); const e = evs.find((x) => x.name === 'PrivateOrderWithdrawn'); const dX = evs.find((x) => x.name === 'Deposited' && x.pool.equals(POOL_SOL));
    check('G private_withdraw_order (relayer service, ed25519): the filled order -> a new SOL note for the one-time key, minus the fee', e && e.amountX === posO.orders[0].filledX && e.amountY === 0n && dX && dX.precommitment === BigInt(nX.precommitment) && dX.value === e.amountX - (e.amountX * BigInt(wd.feeBps)) / 10_000n && dX.beneficiary.equals(ok1.publicKey) && (await emptyEntry())); }
  check('G replaying the signed withdrawal is refused (nonce)', await refused(R.sendV0([V.signedSigIx('orderWithdraw', ok1.publicKey, V.signAction('orderWithdraw', ok1.secretKey, wd), wd), await V.privateWithdrawOrderIx(relayer.publicKey, wd)], [], 1_400_000), /BadNonce|NotEnoughShares/));

  // G3. private zap: a 300 USDC note -> a 5-bin position around the active bin, part swapped to SOL inside the pool
  const zk = Keypair.generate(); bpx = await V.binPool(BPX); const za = bpx.activeId; const zids = range(za - 2, za + 2); const zw = S.shapeWeights(zids, za, 'spot');
  let zd = { binPool: BPX, xIn: false, swapAmount: 0n, minSwapOut: 0n, ids: zids, ...zw, minShares: zids.map(() => 0n), owner: zk.publicKey, feeRecipient: relayer.publicKey, feeBps: 0, deadline: dl() };
  zd.feeBps = (await svcLow.feeQuote(J({ kind: 'zap', d: zd, legs: [{ mint: USDC, value: notes[1].value }] }))).feeBps;
  const v2 = BigInt(notes[1].value); const in2 = v2 - (v2 * BigInt(zd.feeBps)) / 10_000n;
  const zplan = await V.planZap(BPX, { xIn: false, amountIn: in2, ids: zids, ...zw, slippageBps: 200 });
  Object.assign(zd, { swapAmount: zplan.swapAmount, minSwapOut: zplan.minSwapOut, minShares: zplan.minShares });
  check('G private_zap without per-bin minimum shares is refused on chain (before any spend)', await refused(R.sendV0([await V.privateZapIx(relayer.publicKey, { mint: USDC, nullifierHash: 123n }, { ...zd, minShares: [] })], [], 1_400_000), /MinSharesRequired/));
  check('G ...and by the relayer', await refused(svcLow.submit(J({ kind: 'zap', d: { ...zd, minShares: [] }, legs: [{ mint: USDC, p: { proof: Buffer.alloc(256).toString('base64'), pubs: ['1', '2', '3', '4', '5', '6'] } }] })), /minShares/));
  console.log('  proving (private zap)...');
  res = await svcLow.submit(J({ kind: 'zap', d: zd, legs: [{ mint: USDC, p: await proofFor(notes[1], 'zap', zd) }] })); await cuOf(conn, res.txHash, 'private_zap (proof spent + swap + 5 bins)');
  ev = await evOf(res.txHash, 'PrivateZapped');
  const zsh = await Promise.all(zids.map((id) => V.sharesOf(BPX, zk.publicKey, EP, id)));
  check('G private_zap (relayer service): one USDC note -> part swapped to SOL in the pool -> 5 bins owned by a one-time key, each at least its minimum', ev && ev.amountIn === in2 && ev.swapAmount === zplan.swapAmount && zsh.every((s, i) => s === ev.shares[i] && s >= zplan.minShares[i]) && zsh.filter((s) => s > 0n).length === 5 && (await emptyEntry()), `swap ${zplan.swapAmount} -> >= ${zplan.minSwapOut}`);
  // trading so it earns
  for (const [xForY, a] of [[true, units(2, 9)], [false, units(400, 6)], [true, units(1, 9)]]) { r = await swapChecked(carol, BPX, xForY, a); }
  // G4. private claim of the fees it earned, into two new notes
  let posZ = await V.position(BPX, zk.publicKey, EP, zids);
  const cX = newNote(), cY = newNote();
  let cd = { owner: zk.publicKey, binPool: BPX, ids: zids, precommitX: BigInt(cX.precommitment), precommitY: BigInt(cY.precommitment), recipient: null, feeRecipient: relayer.publicKey, feeBps: 0, nonce: 0n, deadline: dl() };
  check('relayer: /fee refuses a claim whose fees are too small to pay the relayer within 1% (here: the full cost floor)', await refused(svc.feeQuote(J({ kind: 'claim', d: cd })), /too small/));
  cd.feeBps = (await svcLow.feeQuote(J({ kind: 'claim', d: cd }))).feeBps;
  { const nc = new Set(zids.map(S.chunkOf)).size; const ix = await V.claimFeesIx(mallory.publicKey, BPX, { owner: zk.publicKey, ids: zids }); ix.keys.splice(ix.keys.length - nc, nc, ...V.binRemaining(BPX, zids, zk.publicKey, EP).slice(-nc));
    check('G nobody can call veyl_bin claim_fees on a private position directly (its authority is the entry\'s signer PDA)', await refused(as(mallory).send([ix], [], 600_000), /WrongShareAccount|MissingShareAccount/)); }
  check('G private_claim_fees without a signature is refused', await refused(R.sendV0([await V.privateClaimFeesIx(relayer.publicKey, cd)], [], 1_400_000), /BadSignature/));
  posZ = await V.position(BPX, zk.publicKey, EP, zids);
  res = await svcLow.submit(J({ kind: 'claim', d: cd, sig: V.signAction('claim', zk.secretKey, cd).toString('base64') })); await cuOf(conn, res.txHash, 'private_claim_fees (5 bins, 2 notes)');
  { const evs = await V.events(res.txHash); const e = evs.find((x) => x.name === 'PrivateFeesClaimed'); const deps = evs.filter((x) => x.name === 'Deposited');
    const net = (v) => v - (v * BigInt(cd.feeBps)) / 10_000n;
    check('G private_claim_fees (relayer service, ed25519): exactly the unclaimed fees the SDK showed -> new SOL and USDC notes for the one-time key', e && e.amountX === posZ.fees.x && e.amountY === posZ.fees.y && e.amountX > 0n && e.amountY > 0n && deps.length === 2 && deps.some((d) => d.pool.equals(POOL_SOL) && d.value === net(e.amountX) && d.precommitment === BigInt(cX.precommitment)) && deps.some((d) => d.pool.equals(POOL_USDC) && d.value === net(e.amountY)) && (await emptyEntry()), `${e && e.amountX} lamports + ${e && e.amountY} USDC atoms`); }
  // G5. private rebalance: the 5 bins -> 7 bins (curve) around the current active bin, the relayer's fee withheld
  { bpx = await V.binPool(BPX); const a = bpx.activeId; const nids = range(a - 3, a + 3); const w = S.shapeWeights(nids, a, 'curve'); const cur = await Promise.all(zids.map((id) => V.sharesOf(BPX, zk.publicKey, EP, id)));
    let rd = { owner: zk.publicKey, binPool: BPX, burnIds: zids, burnShares: cur, ids: nids, ...w, minShares: nids.map(() => 1n), precommitX: BigInt(newNote().precommitment), precommitY: BigInt(newNote().precommitment), recipient: null, feeRecipient: relayer.publicKey, feeBps: 0, nonce: 1n, deadline: dl() };
    rd.feeBps = (await svcLow.feeQuote(J({ kind: 'rebalance', d: rd }))).feeBps;
    check('relayer: a rebalance without a minimum for every new bin is refused', await refused(svcLow.submit(J({ kind: 'rebalance', d: { ...rd, minShares: [] }, sig: Buffer.alloc(64).toString('base64') })), /minShares/));
    const bins = await V.bins(BPX, [...new Set([...zids, ...nids].map(S.chunkOf))]); let ox = 0n, oy = 0n; zids.forEach((id, i) => { const v = V.valueOf(bins.get(id), cur[i]); ox += v.x; oy += v.y; });
    res = await svcLow.submit(J({ kind: 'rebalance', d: rd, sig: V.signAction('rebalance', zk.secretKey, rd).toString('base64') })); await cuOf(conn, res.txHash, 'private_rebalance (5 -> 7 bins)');
    const e = await evOf(res.txHash, 'PrivateRebalanced'); const nsh = await Promise.all(nids.map((id) => V.sharesOf(BPX, zk.publicKey, EP, id)));
    check('G private_rebalance (relayer service, ed25519): the position moves 5 -> 7 bins in one instruction; the relayer\'s fee is withheld from the burned amounts, everything else re-added', e && e.burnedX === ox && e.burnedY === oy && e.feeX === (ox * BigInt(rd.feeBps)) / 10_000n && e.readdedX === ox - e.feeX && e.readdedY === oy - e.feeY && nsh.filter((s) => s > 0n).length === 7 && (await Promise.all(zids.filter((id) => !nids.includes(id)).map((id) => V.sharesOf(BPX, zk.publicKey, EP, id)))).every((s) => s === 0n) && (await emptyEntry()));
    // G6. private reward claim (USDT note)
    await sleep(2500);
    const posR = await V.position(BPX, zk.publicKey, EP, nids); const rn = newNote(); const rcs = [...new Set(nids.map(S.chunkOf))]; const before = {}; for (const c of rcs) before[c] = await V.shareAccount(BPX, zk.publicKey, EP, c);
    let wdr = { owner: zk.publicKey, binPool: BPX, index: 0, ids: nids, precommit: BigInt(rn.precommitment), recipient: null, feeRecipient: relayer.publicKey, feeBps: 0, nonce: 2n, deadline: dl() };
    wdr.feeBps = (await svcLow.feeQuote(J({ kind: 'reward', d: wdr }))).feeBps;
    res = await svcLow.submit(J({ kind: 'reward', d: wdr, sig: V.signAction('reward', zk.secretKey, wdr).toString('base64') })); await cuOf(conn, res.txHash, 'private_claim_reward (7 bins, 1 note)');
    const evs = await V.events(res.txHash); const er = evs.find((x) => x.name === 'PrivateRewardClaimed'); const dr = evs.find((x) => x.name === 'Deposited');
    let expR = 0n; for (const c of rcs) { const b0 = before[c], b1 = await V.shareAccount(BPX, zk.publicKey, EP, c); expR += b0.pendingReward[0]; b0.slots.forEach((sl, i) => { expR += S.owedOf(b1.slots[i].rewardCp[0], sl.rewardCp[0], sl.shares); }); }
    check('G private_claim_reward (relayer service, ed25519): exactly the farm reward the position earned (growth since its checkpoints x shares + settled) -> a new USDT note for the one-time key, minus the fee', er && er.amount === expR && er.amount > 0n && Math.abs(Number(er.amount - posR.rewards[0])) < Number(posR.rewards[0]) / 2 && dr && dr.pool.equals(POOL_USDT) && dr.value === er.amount - (er.amount * BigInt(wdr.feeBps)) / 10_000n && dr.precommitment === BigInt(rn.precommitment) && (await emptyEntry()), `${er && er.amount} USDT atoms`);
    // G7. public payout variant: the rest of the position's fees to a fresh wallet
    for (const [xForY, a2] of [[false, units(300, 6)], [true, units(2, 9)]]) await swapChecked(bob, BPX, xForY, a2);
    const to = Keypair.generate().publicKey; const posP = await V.position(BPX, zk.publicKey, EP, nids);
    let pd = { owner: zk.publicKey, binPool: BPX, ids: nids, precommitX: 0n, precommitY: 0n, recipient: to, feeRecipient: relayer.publicKey, feeBps: 0, nonce: 3n, deadline: dl() };
    pd.feeBps = (await svcLow.feeQuote(J({ kind: 'claim', d: pd }))).feeBps;
    res = await svcLow.submit(J({ kind: 'claim', d: pd, sig: V.signAction('claim', zk.secretKey, pd).toString('base64') })); const ep = await evOf(res.txHash, 'PrivateFeesClaimed');
    const net = (v) => v - (v * BigInt(pd.feeBps)) / 10_000n;
    check('G private_claim_fees to a fresh public wallet instead (recipient): paid there, minus the fee', ep && ep.amountX === posP.fees.x && (await bal(SOL, to)) === net(ep.amountX) && (await bal(USDC, to)) === net(ep.amountY)); }

  // ======================================================================================== H. position limits: compute per bin
  { const MP = await mkPool(13); const meas = {};
    for (const n of [8, 16, 24]) { const ids = range(-n, -1); await as(alice).send(await V.ensureBinAccountsIxs(alice.publicKey, MP, ids, alice.publicKey, alice.publicKey), [], 400_000);
      await as(alice).send([await V.mintIx(alice.publicKey, MP, { ids, amountsX: ids.map(() => 0n), amountsY: ids.map(() => units(10, 6)) })], [], 1_400_000);
      const tx = await as(alice).tx([await V.mintIx(alice.publicKey, MP, { ids, amountsX: ids.map(() => 0n), amountsY: ids.map(() => units(10, 6)) })], alice.publicKey, 1_400_000);
      const bytes = tx.serializeMessage().length + 1 + 64; tx.sign(alice); const s = await conn.sendRawTransaction(tx.serialize()); await conn.confirmTransaction(s, 'confirmed');
      const t = await conn.getTransaction(s, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); meas['mint' + n] = { cu: t.meta.computeUnitsConsumed, bytes };
      const sh = await Promise.all(ids.map((id) => V.sharesOf(MP, alice.publicKey, alice.publicKey, id)));
      const s2 = await as(alice).send([await V.burnIx(alice.publicKey, MP, { ids, shares: sh.map((x) => x / 3n) })], [], 1_400_000); const t2 = await conn.getTransaction(s2, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); meas['burn' + n] = { cu: t2.meta.computeUnitsConsumed }; }
    const slope = (k) => (meas[k + 24].cu - meas[k + 8].cu) / 16; const base = (k) => meas[k + 8].cu - 8 * slope(k);
    // bytes: measured without min_shares (a 24-bin call with them exceeds today's 1,232-byte packets); a bin costs 36 bytes with them
    const perBinBytes = (meas.mint24.bytes - meas.mint8.bytes) / 16 + 16; const fixedBytes = meas.mint8.bytes - 8 * (perBinBytes - 16) + 4;
    { const ids = range(-3007, -3000); await as(alice).send(await V.ensureBinAccountsIxs(alice.publicKey, MP, ids, alice.publicKey, alice.publicKey), [], 400_000);
      await as(alice).send([await V.mintIx(alice.publicKey, MP, { ids, amountsX: ids.map(() => 0n), amountsY: ids.map(() => units(10, 6)) })], [], 1_400_000);
      const s3 = await as(alice).send([await V.mintIx(alice.publicKey, MP, { ids, amountsX: ids.map(() => 0n), amountsY: ids.map(() => units(10, 6)) })], [], 1_400_000);
      meas.mint8far = { cu: (await conn.getTransaction(s3, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).meta.computeUnitsConsumed }; }
    const farSlope = (meas.mint8far.cu - base('mint')) / 8; CU['mint per bin at |id| ~3000'] = Math.round(farSlope);
    const cuMax = Math.floor((1_400_000 - base('mint')) / Math.max(slope('mint'), farSlope)); const byteMax = Math.floor((4096 - fixedBytes) / perBinBytes);
    CU['mint per bin (slope)'] = Math.round(slope('mint')); CU['burn per bin (slope)'] = Math.round(slope('burn')); CU['mint 24 bins'] = meas.mint24.cu; CU['burn 24 bins'] = meas.burn24.cu;
    C.limits = { mintSlope: slope('mint'), farSlope, mintBase: base('mint'), burnSlope: slope('burn'), perBinBytes, fixedBytes, cuMax, byteMax, meas };
    check(`H measured: mint ${Math.round(slope('mint'))} CU/bin (+${Math.round(base('mint'))}), burn ${Math.round(slope('burn'))} CU/bin, ${perBinBytes} bytes/bin; one call fits ${Math.min(cuMax, byteMax)} bins (compute ${cuMax}, 4,096-byte tx ${byteMax}) >= MAX_IDS ${S.MAX_IDS}`, Math.min(cuMax, byteMax) >= S.MAX_IDS, JSON.stringify(meas)); }
  console.log('  phase 1 done at', lap());
};
