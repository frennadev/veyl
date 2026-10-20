'use client';
// The live market feed (Pyth, then Jupiter, CoinGecko, Coinbase; no API key) behind every dollar figure. The Sandbox drives
// its own; on a real chain and in preview its refresh is a query polled every 30 s (one for the page, however many
// screens ask). `useMarketTick()` re-renders on each answer and returns a counter that data hooks can depend on, so dollar
// figures reload once prices arrive.
import { useEffect } from 'react';
import { createStore, useStore } from '@/lib/store';
import { session, useSession } from '@/features/session/session';
import { useChainQuery } from '@/features/session/query';
import type { Runtime } from '@/lib/veyl/types';

const REFRESH_MS = 30_000;
const tick = createStore<{ n: number }>({ n: 0 });
let listening: Runtime | null = null;

export function useMarketTick(): number {
  const rt = useSession((s) => s.rt);
  useEffect(() => { const m = rt?.market; if (!m || listening === rt) return; listening = rt; m.on(() => tick.set((s) => ({ n: s.n + 1 }))); }, [rt]);
  const m = rt?.market;
  useChainQuery(['marketFeed'], m && rt.mode !== 'sandbox' ? async () => { try { await m.refresh(); } finally { tick.set((s) => ({ n: s.n + 1 })); } return Date.now(); } : null,
    { initial: 0, intervalMs: REFRESH_MS, staleMs: REFRESH_MS - 5_000 });
  return useStore(tick, (s) => s.n);
}
/// For code outside React.
export const marketReady = () => !!session.get().rt?.market?.at;
