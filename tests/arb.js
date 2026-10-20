#!/usr/bin/env node
// The arbitrage bot's planning (arb/strategy.js) on a synthetic SOL/USDC pool: no trade while the pool is in line with
// the market or the gap is inside fees; the right direction when it isn't; the swap stops at the last bin that is still
// profitable after fees; trade size, inventory, reserve and profit limits; delisted and empty pools skipped. No validator.
'use strict';
const S = require('../sdk/veyl.js');
const { check, finish } = require('./harness.js');
const { plan, humanPrice, limitBin, feeFraction } = require('../arb/strategy.js');

const DX = 9, DY = 6, NOW = 1_800_000_000;
// a pool at 150 USDC per SOL, bin step 10 (0.1%), 0.05% base fee, quiet (no volatility fee), 0.2% protocol fee
const rawPrice = (human) => BigInt(Math.round((human * 10 ** (DY - DX)) * 2 ** 64)) << 64n;
const pool = (over = {}) => ({ basePrice: rawPrice(150), binStep: 10, activeId: 0, baseFee: 500, variableFeeControl: 10_000n, protocolFeeBps: 20,
  lastSwapAt: NOW - 3600, volAcc: 0n, volRef: 0n, idRef: 0, seeded: true, delisted: false, ...over });
const SOL = 10n ** 9n, USDC = 10n ** 6n;

/// Fake bins: every bin above the active one holds `perBin` SOL, every bin below holds the same value in USDC. Swaps walk
/// bin by bin at each bin's price, paying `fee` on input, like the program.
function simulator(p, perBinSol = 5) {
  const fee = feeFraction(p, NOW);
  return (xForY, amountIn) => {
    let left = Number(amountIn), out = 0, id = p.activeId;
    for (let steps = 0; steps < 256; steps++) {
      const px = humanPrice(p, id, DX, DY);                       // USDC per SOL
      if (!xForY) { // USDC in, SOL out
        const cap = perBinSol * px * 1e6 * (1 + fee);            // USDC (raw) to empty this bin
        if (left <= cap) { out += (left / (1 + fee)) / px / 1e6 * 1e9; left = 0; break; }
        out += perBinSol * 1e9; left -= cap; id++;
      } else {      // SOL in, USDC out
        const cap = (perBinSol * px * 1e6) / px / 1e6 * 1e9 * (1 + fee); // SOL (raw) to empty this bin's USDC
        if (left <= cap) { out += (left / (1 + fee)) / 1e9 * px * 1e6; left = 0; break; }
        out += perBinSol * px * 1e6; left -= cap; id--;
      }
    }
    if (left > 0) throw new Error('InsufficientLiquidity');
    return { out: BigInt(Math.floor(out)), endId: id };
  };
}
const run = (p, market, over = {}) => plan({ p, decX: DX, decY: DY, market, usd: { x: market, y: 1 }, now: NOW, symX: 'SOL', symY: 'USDC',
  balance: { x: 1_000n * SOL, y: 1_000_000n * USDC }, simulate: simulator(p), ...over });

const p = pool();
const at = humanPrice(p, 0, DX, DY);
check('pool price from the bin grid: 150 USDC per SOL at the active bin', Math.abs(at - 150) < 1e-6, at);
const cost = feeFraction(p, NOW);
check('trade cost = base fee 0.05% + protocol fee 0.2% when quiet', Math.abs(cost - 0.0025) < 1e-9, cost);

check('in line with the market: no trade', run(p, 150).action === 'none' && run(p, 150).reason === 'in line');
check('a gap inside fees + margin (0.3%): no trade', run(p, 150 * 1.003).action === 'none');

const up = run(p, 153, { cfg: { maxTradeUsd: 1e9 } }); // the market is 2% above the pool (no size cap, so the limit bin decides)
check('market 2% above: buy SOL with USDC (pushes the price up)', up.action === 'swap' && up.xForY === false, JSON.stringify({ a: up.action, r: up.reason }));
const target = 153 / (1 + cost + 0.001);
check('…stops at the last bin still under market after fees', up.endId <= up.limitId && humanPrice(p, up.limitId, DX, DY) <= target && humanPrice(p, up.limitId + 1, DX, DY) > target);
check('…and is as large as that allows (a bit more would cross the limit bin)', simulator(p)(false, (up.amountIn * 101n) / 100n).endId > up.limitId);
check('…bought below market value: profit after the tx cost is positive', up.profitUsd > 0 && up.outUsd > up.inUsd, up.profitUsd);
check('…minOut leaves 0.5% slippage room', up.minOut === (up.out * 9950n) / 10_000n);

const down = run(p, 147, { cfg: { maxTradeUsd: 1e9 } });
check('market 2% below: sell SOL for USDC (pushes the price down)', down.action === 'swap' && down.xForY === true && down.endId >= down.limitId);
check('…its limit bin is the first still above market after fees', humanPrice(p, down.limitId, DX, DY) >= 147 / (1 - cost - 0.001) && humanPrice(p, down.limitId - 1, DX, DY) < 147 / (1 - cost - 0.001));

const capped = run(p, 153, { cfg: { maxTradeUsd: 100 } });
check('max trade size: $100 caps the USDC in', capped.action === 'swap' && capped.amountIn <= 100n * USDC && capped.amountIn > 99n * USDC);
check('no USDC held: no trade, and says why', run(p, 153, { balance: { x: 1_000n * SOL, y: 0n } }).reason === 'no USDC to trade');
const kept = run(p, 147, { balance: { x: 2n * SOL, y: 0n }, cfg: { reserve: { SOL: 1.5 } } });
check('a reserve is never traded away (2 SOL held, 1.5 kept back)', kept.action === 'swap' && kept.amountIn <= SOL / 2n, String(kept.amountIn));
check('profit below the floor: no trade', run(p, 153, { cfg: { minProfitUsd: 1e9 } }).action === 'none');
check('the tx cost counts against profit', run(p, 153, { cfg: { txCostUsd: 1e9 } }).action === 'none');
check('delisted pool: skipped', run(pool({ delisted: true }), 153).reason === 'delisted');
check('empty pool: skipped', run(pool({ seeded: false }), 153).reason === 'no liquidity');
check('no market price: skipped', run(p, null).reason === 'no market price');

// a busy pool charges a volatility fee on top: the same gap can be inside its cost
const busy = pool({ lastSwapAt: NOW - 5, volRef: 300_000n, volAcc: 300_000n });
check('a volatile pool costs more (volatility fee), so a 1% gap stays untraded', feeFraction(busy, NOW) > cost + 0.005 && run(busy, 151.5).action === 'none', feeFraction(busy, NOW));
check('limitBin agrees with a brute-force scan', (() => { let id = 0; while (humanPrice(p, id + 1, DX, DY) * (1 + cost) <= 160) id++; return limitBin(p, DX, DY, 160, cost, true) === id; })());
finish(null, { cu: false });
