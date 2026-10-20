#!/usr/bin/env node
// The arbitrage bot: keeps Veyl's pool prices in line with the market, so limit orders fill when the market moves (an order
// only fills when a swap crosses its bin). Every ARB_INTERVAL seconds it reads the market (engine/market.js: Pyth with a
// key, Jupiter, CoinGecko, Coinbase), and for each listed pool runs arb/strategy.js on the pool's current state. A swap is
// sent only when the gap clears the pool's fee, the 0.2% protocol fee, a margin and the transaction's cost.
//
//   ARB_KEY=~/keys/veyl/arb.json node arb/arb.js --network devnet          dry run: logs what it would do, sends nothing
//   ARB_LIVE=1 ARB_KEY=… node arb/arb.js --network devnet                  sends the swaps
//
// Env: ARB_KEY (keypair JSON path; needed to send, and to read the bot's balances), ARB_LIVE=1, RPC_URL (else the
// deploy's), ARB_INTERVAL (s, 30), ARB_POOLS (ids, comma-separated; default every listed pool), ARB_MAX_TRADE_USD (2000),
// ARB_MIN_PROFIT_USD (0.5), ARB_MARGIN_BPS (10), ARB_SLIPPAGE_BPS (50), ARB_RESERVE_SOL (0.05: wrapped SOL never traded),
// ARB_MAX_PRICE_AGE (s, 60), ARB_SEAL_GUARD_SLOTS (25), ARB_ONCE=1 (one pass, then exit), PYTH_API_KEY / JUPITER_API_KEY. Mainnet is refused unless
// ARB_MAINNET=1 (only with the owner's go-ahead, after the audit).
//
// Only the pools in deploy.<network>.json are traded (curated, priced from the market by symbol). Pools created on chain
// since are skipped: their tokens may have no market price, and a thin new pool at a creator-chosen price is a trap.
// The bot holds both tokens of each pool as SPL balances (SOL as wrapped SOL) and native SOL for fees; it does not hedge
// elsewhere, so its inventory drifts toward whichever side the market is leaving. Caps bound how far.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const S = require('../sdk/veyl.js'); require('../sdk/sealed.js'); // sealed.js adds V.sealedState
const N = require('../scripts/net.js');
const { plan, direction } = require('./strategy.js');

const env = process.env, num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadMarket() { // engine/market.js is an ES module for the browser bundle: build it for Node, as check-prices does
  const code = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../engine/market.js')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const box = { exports: {} }; new Function('module', 'exports', 'require', code)(box, box.exports, require); return box.exports;
}
function loadKey(f) { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(f.replace(/^~(?=\/)/, os.homedir())), 'utf8')))); }

async function main() {
  const { network } = N.parseArgs();
  const live = env.ARB_LIVE === '1';
  if (network === 'mainnet' && env.ARB_MAINNET !== '1') throw new Error('Refusing mainnet: set ARB_MAINNET=1 only with the owner\'s go-ahead, after the audit.');
  const dep = N.loadDeploy(network); if (!dep) throw new Error('no deploy.' + network + '.json');
  const rpc = env.RPC_URL || dep.rpc; const conn = new Connection(rpc, 'confirmed');
  const key = env.ARB_KEY ? loadKey(env.ARB_KEY) : null;
  if (live && !key) throw new Error('ARB_LIVE=1 needs ARB_KEY (the bot\'s keypair file).');
  const V = new S.Veyl({ connection: conn, programs: dep.programs, payer: key || undefined });
  const M = loadMarket();
  const bySymbol = dep.tokens, symOfMint = Object.fromEntries(Object.entries(dep.tokens).map(([s, t]) => [t.mint, s]));
  const only = env.ARB_POOLS ? new Set(env.ARB_POOLS.split(',').map((s) => s.trim())) : null;
  const pools = dep.binPools.filter((b) => b.address && (!only || only.has(b.id)));
  const priced = Object.keys(bySymbol).filter((s) => M.MAINNET_MINTS[s]);
  const market = new M.Market({ syms: priced, keys: { pyth: env.PYTH_API_KEY, jupiter: env.JUPITER_API_KEY } });
  const cfg = { marginBps: num('ARB_MARGIN_BPS', 10), slippageBps: num('ARB_SLIPPAGE_BPS', 50), maxTradeUsd: num('ARB_MAX_TRADE_USD', 2000),
    minProfitUsd: num('ARB_MIN_PROFIT_USD', 0.5), reserve: { SOL: num('ARB_RESERVE_SOL', 0.05) } };
  const interval = num('ARB_INTERVAL', 30) * 1000, maxAge = num('ARB_MAX_PRICE_AGE', 60) * 1000, sealGuard = BigInt(num('ARB_SEAL_GUARD_SLOTS', 25));
  log(`arb on ${network}${live ? ' — LIVE' : ' — dry run (ARB_LIVE=1 to send)'} · ${pools.length} pools · wallet ${key ? key.publicKey.toBase58() : 'none (balances assumed)'} · every ${interval / 1000}s`);

  let stop = false; process.on('SIGINT', () => { stop = true; log('stopping after this pass'); }); process.on('SIGTERM', () => { stop = true; });
  let backoff = 0;
  while (!stop) {
    try {
      await market.refresh();
      const lamports = key ? BigInt(await conn.getBalance(key.publicKey)) : 10n ** 12n;
      const solUsd = market.usd('SOL') || 0; const txCostUsd = 0.00001 * solUsd; // ~10,000 lamports for a swap with its compute budget
      if (key && lamports < 5_000_000n) log('low on native SOL for fees (' + Number(lamports) / 1e9 + ' SOL): top it up');
      let swaps = 0;
      for (const b of pools) {
        if (stop) break;
        const r = await onePool(b).catch((e) => ({ action: 'error', reason: e.message }));
        if (r.action === 'swap' || r.action === 'sent' || r.action === 'error' || env.ARB_VERBOSE === '1') log(b.id.padEnd(16), r.line || r.reason);
        if (r.action === 'sent') swaps++;
        await sleep(250); // keep the shared RPC comfortable
      }
      backoff = 0; if (swaps) log(`pass done: ${swaps} swap${swaps === 1 ? '' : 's'}`);

      async function onePool(b) {
        const addr = new PublicKey(b.address); const p = await V.binPool(addr); if (!p) return { action: 'none', reason: 'no pool account' };
        const sx = symOfMint[p.mintX.toBase58()], sy = symOfMint[p.mintY.toBase58()]; if (!sx || !sy) return { action: 'none', reason: 'unknown mint' };
        const px = market.prices[sx], py = market.prices[sy];
        const stale = [[sx, px], [sy, py]].filter(([, q]) => !q || Date.now() - q.at > maxAge).map(([s]) => s);
        if (stale.length) return { action: 'none', reason: 'no fresh market price for ' + stale.join(', ') + (stale.some((s) => !M.MAINNET_MINTS[s]) ? ' (not in engine/market.js MAINNET_MINTS)' : '') };
        const ctx = { p, decX: bySymbol[sx].decimals, decY: bySymbol[sy].decimals, market: px.usd / py.usd, usd: { x: px.usd, y: py.usd }, symX: sx, symY: sy, cfg: { ...cfg, txCostUsd } };
        const d = direction(ctx); if (d.xForY === null) return { action: 'none', reason: d.reason };
        // a sealed batch settles as one net swap at the pool's price: don't move it right before or while it settles
        try { const st = await V.sealedState(addr); const bt = st && st.batch;
          if (bt && (bt.state === 'closed' || (bt.state === 'open' && bt.endSlot - BigInt(st.slot) < sealGuard))) return { action: 'none', reason: 'sealed batch settling' }; } catch { /* not a sealed pool */ }
        const bins = await V.bins(addr, S.chunksForSwap(p, d.xForY)); const now = Math.floor(Date.now() / 1000);
        const balance = key ? { x: await V.tokenBalance(p.mintX, key.publicKey), y: await V.tokenBalance(p.mintY, key.publicKey) } : { x: 1n << 62n, y: 1n << 62n };
        const r = plan({ ...ctx, now, balance, simulate: (xForY, a) => S.simulateSwap(p, bins, xForY, a, now) });
        if (r.action !== 'swap') return r;
        const [sIn, sOut, dIn, dOut] = r.xForY ? [sx, sy, ctx.decX, ctx.decY] : [sy, sx, ctx.decY, ctx.decX];
        const line = `pool ${r.pool.toPrecision(6)} vs market ${r.market.toPrecision(6)} (${r.gapBps > 0 ? '+' : ''}${r.gapBps} bps, cost ${r.costBps}): `
          + `${Number(r.amountIn) / 10 ** dIn} ${sIn} → ${Number(r.out) / 10 ** dOut} ${sOut}, est. +$${r.profitUsd.toFixed(2)}`;
        if (!live) return { action: 'swap', line: 'would swap ' + line };
        const mintOut = r.xForY ? p.mintY : p.mintX, tpOut = r.xForY ? p.tokenProgramY : p.tokenProgramX;
        const ataIx = spl.createAssociatedTokenAccountIdempotentInstruction(key.publicKey, V.ata(mintOut, key.publicKey, tpOut), key.publicKey, mintOut, tpOut);
        const sig = await V.send([ataIx, await V.swapIx(key.publicKey, addr, r.xForY, r.amountIn, r.minOut, p)], [], 400_000);
        return { action: 'sent', line: 'swapped ' + line + ' · ' + sig };
      }
    } catch (e) {
      backoff = Math.min(backoff ? backoff * 2 : interval, 300_000); log('pass failed:', e.message, `· retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff); continue;
    }
    if (env.ARB_ONCE === '1') break;
    await sleep(interval);
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
