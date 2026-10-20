// The listed pools when the page has no deployment (preview): the 12 built-in pools (defined in scripts/lib.js BIN_POOLS,
// repeated here until that list moves to config/) and every Meteora pair from config/catalog.json, in the deploy's order.
// Read at build time: the catalog is bundled into the page.
import catalog from '../../../config/catalog.json';
import type { PoolConfig } from './types';

interface CatalogPool { id: string; x: string; y: string; binStep: number; baseFee: number }
const BUILTIN: CatalogPool[] = [
  { id: 'sol-usdc', x: 'SOL', y: 'USDC', binStep: 10, baseFee: 500 }, { id: 'sol-usdt', x: 'SOL', y: 'USDT', binStep: 10, baseFee: 500 },
  { id: 'jup-sol', x: 'JUP', y: 'SOL', binStep: 20, baseFee: 2000 }, { id: 'bonk-sol', x: 'BONK', y: 'SOL', binStep: 50, baseFee: 5000 },
  { id: 'usdt-usdc', x: 'USDT', y: 'USDC', binStep: 1, baseFee: 100 }, { id: 'jup-usdc', x: 'JUP', y: 'USDC', binStep: 20, baseFee: 2000 },
  { id: 'bonk-usdc', x: 'BONK', y: 'USDC', binStep: 50, baseFee: 5000 }, { id: 'wif-sol', x: 'WIF', y: 'SOL', binStep: 50, baseFee: 5000 },
  { id: 'wif-usdc', x: 'WIF', y: 'USDC', binStep: 50, baseFee: 5000 }, { id: 'jto-sol', x: 'JTO', y: 'SOL', binStep: 20, baseFee: 2000 },
  { id: 'pyth-usdc', x: 'PYTH', y: 'USDC', binStep: 20, baseFee: 2000 }, { id: 'ray-sol', x: 'RAY', y: 'SOL', binStep: 20, baseFee: 2000 },
];

const all = [...BUILTIN, ...(catalog.binPools as CatalogPool[]).filter((b) => !BUILTIN.some((x) => x.id === b.id))];
export const PREVIEW_POOLS: PoolConfig[] = all.map((b) => ({ id: b.id, x: b.x, y: b.y, bs: b.binStep, base: b.baseFee / 1e4, address: null }));
