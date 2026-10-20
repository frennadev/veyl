'use client';
// The pools: the directory (which pools exist), their live state and their figures, all React Query (features/session/query):
//  - directory: once a minute, re-read from the chain when the pool count changes (someone created a pool); public, persisted;
//  - states: every 15 s, every pool in one batched read (bins near the price only); keyed by the set of pools, so the
//    pools list, the pool page and the positions all share it;
//  - figures over the interval: right after the states, then every minute on a real chain (they read each pool's
//    transactions) or with every state refresh in the Sandbox; streamed row by row; public, persisted, so a return visit
//    shows the whole table at once while it refreshes.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useSession } from '@/features/session/session';
import { useMarketTick } from '@/features/market/market';
import { fullKey, networkKey, queryClient, useChainQuery } from '@/features/session/query';
import { poolsUi } from './state';
import { useStore } from '@/lib/store';
import { LIST_SPAN, loadPoolStates, loadPoolStats, type Interval, type PoolView } from '@/lib/veyl/services/pools';
import { PREVIEW_POOLS } from '@/lib/veyl/previewPools';
import type { PoolConfig, PoolState, PoolStats, Runtime } from '@/lib/veyl/types';

const STATE_MS = 15_000, CHAIN_STATS_MS = 60_000, DIRECTORY_MS = 60_000, COUNT_MS = 15_000;
type States = Record<string, { st: PoolState | null; err: string | null }>;
type Stats = Record<string, PoolStats | null>;

// ---------------------------------------------------------------- the directory
let listedAt: number | null = null; // the pool count the directory was last read at
/// The pools on chain when the engine can list them (open pool creation: anyone can add one); else the deployment's own.
export function usePoolConfigs(): PoolConfig[] {
  const rt = useSession((s) => s.rt);
  const E = rt?.engine;
  const dir = useChainQuery<PoolConfig[] | null>(['poolDirectory'], E?.listPools ? () => {
    const count = queryClient.getQueryData<number>(fullKey(['poolCount'])) ?? null;
    const fresh = count != null && listedAt != null && count !== listedAt; listedAt = count ?? listedAt;
    return E.listPools!({ includeDelisted: true, fresh });
  } : null, { initial: null, intervalMs: DIRECTORY_MS, staleMs: 30_000, persist: true });
  // the cheap count (addresses only) starts once the directory has been read, so the two don't scan the chain together
  const count = useChainQuery<number | null>(['poolCount'], E?.poolCount && dir.updatedAt ? () => E.poolCount!() : null, { initial: null, intervalMs: COUNT_MS, staleMs: COUNT_MS });
  useEffect(() => {
    if (count.data == null) return;
    if (listedAt == null) listedAt = count.data;
    else if (count.data !== listedAt) queryClient.invalidateQueries({ queryKey: fullKey(['poolDirectory']) }, { cancelRefetch: false });
  }, [count.data]);
  return dir.data || (rt?.cfg ? rt.cfg.binPools : PREVIEW_POOLS);
}

/// Pools the engine itself knows (its config, plus every pool its directory has discovered this visit). A pool restored
/// from the persisted directory isn't read until the engine has discovered it too.
const engineKnows = (rt: Runtime | null, p: PoolConfig) => !!p.address && !!rt?.cfg?.binPools.some((b) => b.address === p.address);

// ---------------------------------------------------------------- states and figures
const statsKey = (iv: Interval, sig: string) => ['poolStats', iv, sig];
/// Each pool's last state read, so a read for a grown set of pools (the directory found more) only reads the new ones.
const recent = new Map<string, { r: States[string]; at: number }>(); const REUSE_MS = 5_000;
async function readStates(rt: Runtime, pools: PoolConfig[], emit: (s: States) => void): Promise<States> {
  const now = Date.now(); const out: States = {};
  for (const p of pools) { const c = recent.get(p.id); if (c && now - c.at < REUSE_MS) out[p.id] = c.r; }
  const need = pools.filter((p) => !(p.id in out));
  const got = need.length ? await loadPoolStates(rt.engine!, need, (s) => emit({ ...out, ...s })) : {};
  for (const [id, r] of Object.entries(got)) if (r.st) recent.set(id, { r, at: Date.now() }); else recent.delete(id); // a failed read is retried
  return { ...out, ...got };
}

export function usePoolViews(iv: Interval): { pools: PoolView[]; live: boolean } {
  const rt = useSession((s) => s.rt);
  const rpcOk = useSession((s) => s.rpc !== 'down');
  const configs = usePoolConfigs();
  const live = !!rt?.engine && rpcOk;
  const priced = useMarketTick() > 0;

  // delisted pools are hidden unless asked for: their live state is read only then
  const showDelisted = useStore(poolsUi, (s) => s.filter.delisted);
  const reading = useMemo(() => configs.filter((c) => (showDelisted || c.status !== 'delisted') && engineKnows(rt, c)), [configs, showDelisted, rt]);
  const sig = reading.map((c) => c.address).join(',');

  const states = useChainQuery<States>(['poolStates', LIST_SPAN, sig], live && sig ? (emit) => readStates(rt!, reading, emit) : null,
    { initial: {}, intervalMs: STATE_MS, staleMs: 5_000 });
  const base = useMemo<PoolView[]>(() => {
    const E = rt?.mode === 'chain' ? rt.engine : null;
    const usd = E ? E.usdMap(Object.values(states.data).map((r) => r.st)) : {};
    return configs.map((c) => { const st = states.data[c.id]?.st ?? null; const ux = usd[c.x], uy = usd[c.y];
      const liqUsd = E && st && ux != null && uy != null ? E.fmt(c.x, st.reserves.x) * ux + E.fmt(c.y, st.reserves.y) * uy : null;
      return { ...c, st, err: states.data[c.id]?.err ?? null, stats: null, liqUsd }; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configs, states.data, rt, priced]);

  // figures need the states (and in the Sandbox are recomputed with every state refresh)
  const statesReady = !states.loading && Object.keys(states.data).length > 0;
  const sandbox = rt?.mode === 'sandbox';
  const stats = useChainQuery<Stats>([...statsKey(iv, sig), priced, sandbox ? states.updatedAt : 0], live && statesReady ? (emit) => loadPoolStats(rt!, base, iv, emit) : null,
    { initial: {}, intervalMs: rt?.mode === 'chain' ? CHAIN_STATS_MS : undefined, staleMs: 30_000, persist: rt?.mode === 'chain' });
  // until this visit's figures land, a pool shows the last ones cached for it (this visit or, persisted, the last)
  const cached = useLatestStats(iv);
  const pools = useMemo(() => base.map((p) => ({ ...p, stats: (p.id in stats.data ? stats.data[p.id] : cached?.[p.id]) ?? null })), [base, stats.data, cached]);
  return { pools, live };
}

/// The newest figures in the cache for this network and interval (any set of pools), or null; updates with the cache.
function useLatestStats(iv: Interval): Stats | null {
  const ref = useRef<{ at: number; data: Stats | null }>({ at: -1, data: null });
  return useSyncExternalStore((cb) => queryClient.getQueryCache().subscribe(cb), () => {
    let best: { at: number; data: Stats | null } = { at: 0, data: null };
    for (const q of queryClient.getQueryCache().findAll({ queryKey: [networkKey(), 'poolStats', iv] })) {
      if (q.state.data && q.state.dataUpdatedAt > best.at) best = { at: q.state.dataUpdatedAt, data: q.state.data as Stats };
    }
    if (best.at !== ref.current.at) ref.current = best; // a stable reference until a newer answer lands
    return ref.current.data;
  }, () => null);
}

/// Total liquidity across the pools with known figures (null until any are known), for the header on every page.
export function usePoolTotals(): number | null {
  const iv = useStore(poolsUi, (s) => s.iv);
  const stats = useLatestStats(iv);
  return useMemo(() => { if (!stats) return null; const v = Object.values(stats).filter((s): s is PoolStats => s?.tvlUsd != null);
    return v.length ? v.reduce((a, s) => a + (s.tvlUsd as number), 0) : null; }, [stats]);
}

/// One pool's newest state and figures from any cached read (the list's, the positions'), for a screen that shows it
/// before its own read lands.
export function cachedPoolState(id: string): { st: PoolState | null; err: string | null } | undefined {
  let best: { at: number; v?: States[string] } = { at: 0 };
  for (const q of queryClient.getQueryCache().findAll({ queryKey: [networkKey(), 'poolStates'] })) {
    const v = (q.state.data as States | undefined)?.[id]; if (v?.st && q.state.dataUpdatedAt > best.at) best = { at: q.state.dataUpdatedAt, v };
  }
  return best.v;
}
export function cachedPoolStats(iv: Interval, id: string): PoolStats | null | undefined {
  let best: { at: number; v?: PoolStats } = { at: 0 };
  for (const q of queryClient.getQueryCache().findAll({ queryKey: [networkKey(), 'poolStats', iv] })) {
    const v = (q.state.data as Stats | undefined)?.[id]; if (v && q.state.dataUpdatedAt > best.at) best = { at: q.state.dataUpdatedAt, v };
  }
  return best.v;
}
