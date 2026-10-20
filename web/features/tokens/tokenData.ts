'use client';
// Token names and logos from Jupiter's token list, through our relayer (relayer/tokens.js), so Jupiter and logo hosts never
// see a visitor. Privacy: the app always asks for the same fixed set, every token on this site's pools, and preloads every
// logo in a fixed order, so the relayer can't tell which tokens a visitor holds or looks at. The only single lookup is a
// mint someone pastes on the Create page, where creating the pool is public anyway.
// Keys: on mainnet a token is looked up by its mint. On devnet / local, listed tokens are mock mints Jupiter has never seen,
// so they are looked up as sym:<SYMBOL> (display only; the relayer refuses that on mainnet).
// Requests are React Query (public, persisted for a day: names and logos rarely change); the store below is only an index
// by key, so every logo on the page can look itself up without a query of its own.
import { useEffect, useMemo } from 'react';
import { createStore, useStore } from '@/lib/store';
import { session, useSession } from '@/features/session/session';
import { usePoolConfigs } from '@/features/pools/usePoolViews';
import { fullKey, queryClient, useChainQuery } from '@/features/session/query';

export interface RemoteToken { mint: string; symbol: string; name: string; decimals: number; verified: boolean; tags: string[]; icon: string | null }
const NATIVE_SOL = 'So11111111111111111111111111111111111111112';
const BATCH = 100;

const store = createStore<{ byKey: Record<string, RemoteToken | null> }>({ byKey: {} });
const DAY = 24 * 3600_000;
let preloaded = ''; // the fixed set whose logos were preloaded

const relayerUrl = () => session.get().rt?.cfg?.relayer || null;
const mainnet = () => (session.get().rt?.cfg as { cluster?: string } | null | undefined)?.cluster === 'mainnet';
const isMintLike = (k: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(k);

/// The relayer lookup key for a token key (a listed symbol or a mint).
export function remoteKey(k: string): string | null {
  const E = session.get().rt?.engine; if (!E) return null;
  if (isMintLike(k)) return k; // tokens from pools anyone created are keyed by their mint: always looked up by it
  const t = E.tokens[k]; if (!t) return null;
  return mainnet() || t.mint === NATIVE_SOL ? t.mint : 'sym:' + k; // a listed symbol: by mint on mainnet, by symbol on devnet's mock mints
}

async function fetchKeys(keys: string[]): Promise<Record<string, RemoteToken | null>> {
  const base = relayerUrl(); if (!base || !keys.length) return {};
  const out: Record<string, RemoteToken | null> = {}; let answered = 0;
  for (let i = 0; i < keys.length; i += BATCH) {
    try {
      const r = await fetch(base + '/tokens?ids=' + encodeURIComponent(keys.slice(i, i + BATCH).join(',')));
      if (r.ok) { Object.assign(out, (await r.json()).tokens || {}); answered++; }
    } catch { /* relayer down: drawn marks stay */ }
  }
  if (!answered) throw new Error('The relayer did not answer.'); // not cached as "no data": retried
  return out;
}

/// The logo's URL on the relayer, or null.
export const iconUrl = (t: RemoteToken | null | undefined) => (t?.icon && relayerUrl() ? relayerUrl() + t.icon : null);

/// Loads the fixed set (every token on the site's pools) once (again when pools are added), and preloads every logo.
export function TokenDataSync() {
  const rt = useSession((s) => s.rt);
  const pools = usePoolConfigs();
  const keys = useMemo(() => (rt?.engine ? [...new Set([...Object.keys(rt.engine.tokens), ...pools.flatMap((p) => [p.x, p.y])].map(remoteKey).filter((k): k is string => !!k))].sort() : []), [rt, pools]);
  const sig = keys.join(',');
  const r = useChainQuery<Record<string, RemoteToken | null>>(['tokenMeta', sig], rt?.cfg?.relayer && keys.length ? () => fetchKeys(keys) : null, { initial: {}, staleMs: DAY, persist: true });
  useEffect(() => {
    if (!Object.keys(r.data).length) return;
    store.set((s) => ({ byKey: { ...s.byKey, ...r.data } }));
    if (preloaded === sig) return; preloaded = sig;
    for (const k of keys) { const u = iconUrl(r.data[k]); if (u) { const img = new Image(); img.src = u; } } // same order for everyone
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.data]);
  return null;
}

/// Jupiter's data for a token key, if loaded.
export function useRemoteToken(k: string | null | undefined): RemoteToken | null {
  const key = k ? remoteKey(k) : null;
  return useStore(store, (s) => (key ? s.byKey[key] ?? null : null));
}

/// A single mint someone pasted (Create page): looked up on demand, cached with the rest.
export async function lookupMint(mint: string): Promise<RemoteToken | null> {
  if (!isMintLike(mint)) return null;
  const have = store.get().byKey[mint]; if (have !== undefined) return have;
  const v = await queryClient.fetchQuery({ queryKey: fullKey(['tokenMeta1', mint]), queryFn: async () => (await fetchKeys([mint]))[mint] ?? null, staleTime: DAY, meta: { persist: true } });
  store.set((s) => ({ byKey: { ...s.byKey, [mint]: v } }));
  return v;
}
