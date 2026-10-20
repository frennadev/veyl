// Pools: reading their state and figures through the engine, and the pure rules of the pools list (categories, filters,
// sorting). No React here.
import type { PoolConfig, PoolState, PoolStats, Runtime, Sym, UnitsPort, PoolReadPort } from '../types';
import { tokenName } from '@/lib/tokens';

/// liqUsd: liquidity in dollars from the state alone (reserves at market prices, unpriced tokens valued through pools),
/// the same figure the stats compute, available before them; null when a token can't be priced.
export interface PoolView extends PoolConfig { st: PoolState | null; err: string | null; stats: PoolStats | null; liqUsd?: number | null }
export type Interval = 3600 | 21600 | 86400;
export const INTERVALS: Interval[] = [3600, 21600, 86400];
export const INTERVAL_LABEL: Record<Interval, string> = { 3600: '1h', 21600: '6h', 86400: '24h' };

// ---------------------------------------------------------------- reads
/// Pool reads in flight at once: public RPCs rate-limit a burst of every pool (dozens of accounts each).
const READ_CONCURRENCY = 4, STATS_CONCURRENCY = 3;
/// Bins read either side of the price: the list and the figures (depth near the price) share one read. Still one bins
/// request per pool, so it costs the same as reading only the active bin.
export const LIST_SPAN = 10;
type StateRead = { st: PoolState | null; err: string | null };

/// Runs `job` over `items`, `n` at a time.
async function pooled<T>(items: T[], n: number, job: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { for (let it = queue.shift(); it !== undefined; it = queue.shift()) await job(it); }));
}

/// Every pool's on-chain state, a few at a time. A pool that fails keeps its error, not the page. `onEach` is called as
/// each pool lands, with everything read so far, so rows fill in one by one.
export async function loadPoolStates(engine: PoolReadPort, pools: PoolConfig[], onEach?: (sofar: Record<string, StateRead>) => void, span = LIST_SPAN): Promise<Record<string, StateRead>> {
  const out: Record<string, StateRead> = {};
  if (engine.poolStates) { // one batched read for the whole list (a few requests in all)
    const withAddr = pools.filter((p) => p.address);
    for (const p of pools) if (!p.address) out[p.id] = { st: null, err: null };
    try {
      const got = await engine.poolStates(withAddr.map((p) => p.address!), span);
      withAddr.forEach((p, i) => { const g = got[i]; out[p.id] = g instanceof Error ? { st: null, err: g.message } : { st: g, err: null }; });
      return out;
    } catch { /* the batch failed as a whole: one pool at a time below */ }
  }
  await pooled(pools, READ_CONCURRENCY, async (p) => {
    if (!p.address) { out[p.id] = { st: null, err: null }; return; }
    try { out[p.id] = { st: await engine.poolState(p.address, span), err: null }; }
    catch (e) { out[p.id] = { st: null, err: String((e as Error)?.message || e) }; }
    onEach?.({ ...out });
  });
  return out;
}

/// Each pool's figures over the interval. Sandbox: from its state (instant). Chain: from each pool's Swapped events, the
/// state already read for the list and the market, a few pools at a time (the first read of a pool's history is the slow
/// part; later ones only fetch what's new). `onEach` as above. Preview: none.
export async function loadPoolStats(rt: Runtime, pools: PoolView[], iv: Interval, onEach?: (sofar: Record<string, PoolStats | null>) => void): Promise<Record<string, PoolStats | null>> {
  const out: Record<string, PoolStats | null> = {};
  if (rt.mode === 'sandbox') {
    for (const p of pools) { if (!p.address || !p.st) continue; try { out[p.id] = rt.engine.poolStats(p.address, iv); } catch { out[p.id] = null; } }
  } else if (rt.mode === 'chain') {
    const usd = rt.engine.usdMap(pools.map((p) => p.st));
    await pooled(pools.filter((p) => p.address && p.st), STATS_CONCURRENCY, async (p) => {
      try { out[p.id] = await rt.engine.poolStatsChain(p.address!, iv, p.st!, usd); } catch { out[p.id] = null; }
      onEach?.({ ...out });
    });
  }
  return out;
}

// ---------------------------------------------------------------- derived figures
type Prices = UnitsPort & PoolReadPort;
export const priceOf = (E: Prices, p: PoolView): number | null => (p.st ? E.humanPrice(p.st, p.st.active) : null);
/// Liquidity in the pool's second token (Y), at the active price.
export const liquidityInY = (E: Prices, p: PoolView): number =>
  p.st ? E.fmt(p.x, p.st.reserves.x) * E.humanPrice(p.st, p.st.active) + E.fmt(p.y, p.st.reserves.y) : 0;

// ---------------------------------------------------------------- list rules
export type Category = 'majors' | 'stables' | 'volatile';
export const CATEGORIES: { id: Category | 'all'; label: string }[] = [
  { id: 'all', label: 'All pools' }, { id: 'majors', label: 'Majors' }, { id: 'stables', label: 'Stables' }, { id: 'volatile', label: 'Volatile' },
];
const STABLE = new Set(['USDC', 'USDT']), MAJOR = new Set(['SOL', 'USDC', 'USDT']);
export const categoryOf = (p: PoolConfig): Category =>
  STABLE.has(p.x) && STABLE.has(p.y) ? 'stables' : MAJOR.has(p.x) && MAJOR.has(p.y) ? 'majors' : 'volatile';

/// status: which listing statuses to show; delisted pools (withdrawals only) are hidden unless asked for.
export interface PoolFilter { q: string; cat: Category | 'all'; tok: Sym | 'all'; base: string; bs: string; status: 'all' | 'verified' | 'unverified'; delisted: boolean }
export const NO_FILTER: PoolFilter = { q: '', cat: 'all', tok: 'all', base: 'all', bs: 'all', status: 'all', delisted: false };
/// A pool's status; pools from an engine without listing statuses are verified (listed by Veyl).
export const statusOf = (p: PoolConfig) => p.status || 'verified';
export const activeFilterCount = (f: PoolFilter) => +(f.base !== 'all') + +(f.bs !== 'all') + +(f.tok !== 'all');

export function filterOptions(pools: PoolConfig[]) {
  const uniq = <T,>(a: T[]) => [...new Set(a)];
  return {
    tokens: uniq(pools.flatMap((p) => [p.x, p.y])),
    bases: uniq(pools.map((p) => p.base)).sort((a, b) => a - b),
    binSteps: uniq(pools.map((p) => p.bs)).sort((a, b) => a - b),
  };
}

export function filterPools<T extends PoolConfig>(pools: T[], f: PoolFilter): T[] {
  const q = f.q.trim().toLowerCase().replace('–', '-');
  return pools.filter((p) =>
    (f.cat === 'all' || categoryOf(p) === f.cat) &&
    (f.tok === 'all' || p.x === f.tok || p.y === f.tok) &&
    (f.base === 'all' || String(p.base) === f.base) &&
    (f.bs === 'all' || String(p.bs) === f.bs) &&
    (statusOf(p) === 'delisted' ? f.delisted : f.status === 'all' || statusOf(p) === f.status) &&
    (!q || p.mintX === f.q.trim() || p.mintY === f.q.trim() || p.address === f.q.trim() || `${p.x}-${p.y} ${p.x}/${p.y} ${p.x}${p.y} ${tokenName(p.x)} ${tokenName(p.y)}`.toLowerCase().includes(q)));
}

export type SortKey = 'score' | 'age' | 'liq' | 'vol' | 'fpt' | 'apr' | 'fee' | 'bs' | 'name';
export const SORTS: { id: SortKey; label: string }[] = [
  { id: 'score', label: 'Score' }, { id: 'age', label: 'Age' }, { id: 'liq', label: 'Liquidity' }, { id: 'vol', label: 'Volume' },
  { id: 'fpt', label: 'Fees / TVL' }, { id: 'apr', label: 'APR' }, { id: 'fee', label: 'Fee now' }, { id: 'bs', label: 'Bin step' }, { id: 'name', label: 'Name' },
];

/// Highest first; a missing figure sorts last. Liquidity falls back to the pool's own reserves (in dollars when Y is priced).
export function sortPools(pools: PoolView[], key: SortKey, liqFallback: (p: PoolView) => number): PoolView[] {
  if (key === 'name') return [...pools].sort((a, b) => (a.x + a.y).localeCompare(b.x + b.y));
  const n = (v: number | null | undefined) => (v == null ? -1 : v);
  const val: Record<Exclude<SortKey, 'name'>, (p: PoolView) => number> = {
    score: (p) => n(p.stats?.score), age: (p) => n(p.stats?.ageSec), vol: (p) => n(p.stats?.volumeUsd), fpt: (p) => n(p.stats?.feeTvlPct),
    apr: (p) => n(p.stats?.aprPct), liq: (p) => (p.stats ? n(p.stats.tvlUsd) : p.liqUsd ?? liqFallback(p)), fee: (p) => (p.st ? p.st.fee : p.base * 1e4), bs: (p) => p.bs,
  };
  const f = val[key]; return [...pools].sort((a, b) => f(b) - f(a));
}

/// A quote's swap fees in units of the input token, when the engine reports them (part 2): the pools' LP fee and Veyl's
/// protocol fee. null on engines that don't.
export function quoteFees(E: UnitsPort, sym: Sym, q: { lpFee?: bigint; protocolFee?: bigint } | null | undefined): { lp: number; protocol: number } | null {
  if (!q || q.lpFee == null || q.protocolFee == null) return null;
  return { lp: E.fmt(sym, q.lpFee), protocol: E.fmt(sym, q.protocolFee) };
}
