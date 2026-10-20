// The Sandbox's play world: real tokens (SOL, USDC, USDT, JUP, BONK), pools whose prices follow the live market (Pyth, then
// Jupiter; the last 24 hours from public candles) when the browser can reach it. `price` is only the fallback used when no
// market price is available, and the app then says so. Liquidity and bot sizes are in dollars (play money).
export const TOKENS = [
  { sym: 'SOL', decimals: 9, name: 'Solana', price: 107.5 },
  { sym: 'USDC', decimals: 6, name: 'USD Coin', price: 1 },
  { sym: 'USDT', decimals: 6, name: 'Tether USD', price: 1 },
  { sym: 'JUP', decimals: 6, name: 'Jupiter', price: 0.317 },
  { sym: 'BONK', decimals: 5, name: 'Bonk', price: 0.0000033 },
];
/// When the fallback prices above were last checked against the market (shown to the user whenever the live feed is unreachable).
export const PRICES_AS_OF = '14 Oct 2026';
const SEALED = (minX, minY) => ({ epochSlots: 50, minIn: [minX, minY], kMin: 3, maxRollovers: 4, settleSlots: 150, maxDrift: 40 });
export const POOLS = [
  { id: 'sol-usdc', x: 'SOL', y: 'USDC', binStep: 10, baseFee: 500, vfc: 10000, span: 50, liqUsd: 14000, botUsd: 250, wander: 6, category: 'majors',
    reward: { sym: 'USDT', amount: 20000, days: 7 }, sealed: SEALED(10_000_000n, 1_000_000n), sealBotUsd: 9 },
  { id: 'sol-usdt', x: 'SOL', y: 'USDT', binStep: 10, baseFee: 500, vfc: 10000, span: 50, liqUsd: 9000, botUsd: 180, wander: 6, category: 'majors' },
  { id: 'usdt-usdc', x: 'USDT', y: 'USDC', binStep: 1, baseFee: 100, vfc: 10000, span: 20, liqUsd: 40000, botUsd: 400, wander: 3, category: 'stables',
    sealed: SEALED(1_000_000n, 1_000_000n), sealBotUsd: 8 },
  { id: 'jup-sol', x: 'JUP', y: 'SOL', binStep: 20, baseFee: 2500, vfc: 2500, span: 50, liqUsd: 12000, botUsd: 150, wander: 8, category: 'volatile' },
  { id: 'bonk-sol', x: 'BONK', y: 'SOL', binStep: 50, baseFee: 5000, vfc: 2500, span: 40, liqUsd: 9000, botUsd: 120, wander: 12, category: 'volatile' },
];
/// Flat relayer fees in the Sandbox (atoms): what the relayer would charge to post a proof and submit.
export const FEES = { SOL: 20_000n, USDC: 2_000n, USDT: 2_000n, JUP: 5_000n, BONK: 200_000_00n };
