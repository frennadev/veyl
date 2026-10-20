'use client';
// One pool's live data for its page: the state with 35 bins each side of the price (every 15 s), and its figures over the
// interval (for the price chart, the stats, volatility and the fee estimate). Until its own reads land it shows the same
// pool from the pools list's cached reads, so opening a pool from the list is instant.
import { useMemo } from 'react';
import { useSession } from '@/features/session/session';
import { useMarketTick } from '@/features/market/market';
import { useChainQuery } from '@/features/session/query';
import { cachedPoolState, cachedPoolStats, usePoolConfigs } from '@/features/pools/usePoolViews';
import { usePoolsUi } from '@/features/pools/state';
import { loadPoolStats, type PoolView } from '@/lib/veyl/services/pools';
import type { PoolState } from '@/lib/veyl/types';

const SPAN = 35, STATE_MS = 15_000, CHAIN_STATS_MS = 60_000;

export function usePoolData(id: string): { pool: PoolView | null; loading: boolean; live: boolean } {
  const rt = useSession((s) => s.rt), rpcOk = useSession((s) => s.rpc !== 'down');
  const cfg = usePoolConfigs().find((p) => p.id === id) || null;
  const { iv } = usePoolsUi();
  const live = !!rt?.engine && rpcOk && !!cfg?.address;

  const state = useChainQuery<{ st: PoolState | null; err: string | null }>(['poolState', cfg?.address, SPAN],
    live ? async () => { try { return { st: await rt!.engine!.poolState(cfg!.address!, SPAN), err: null }; } catch (e) { return { st: null, err: String((e as Error).message || e) }; } } : null,
    { initial: { st: null, err: null }, intervalMs: STATE_MS, staleMs: 5_000, keepPrevious: false, placeholder: () => cachedPoolState(id) });
  const base = useMemo<PoolView | null>(() => (cfg ? { ...cfg, st: state.data.st, err: state.data.err, stats: null } : null), [cfg, state.data]);
  const priced = useMarketTick() > 0;
  const stats = useChainQuery<PoolView['stats']>(['poolStat', cfg?.address, iv, priced, rt?.mode === 'sandbox' ? state.updatedAt : 0], live && base?.st ? async () => (await loadPoolStats(rt!, [base!], iv))[id] ?? null : null,
    { initial: null, intervalMs: rt?.mode === 'chain' ? CHAIN_STATS_MS : undefined, staleMs: 30_000, placeholder: () => cachedPoolStats(iv, id) });

  const pool = useMemo(() => (base ? { ...base, stats: stats.data } : null), [base, stats.data]);
  return { pool, loading: live && state.loading && !state.data.st, live }; // a cached read counts: the page shows it
}
