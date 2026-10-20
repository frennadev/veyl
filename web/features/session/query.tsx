'use client';
// Every request the app makes goes through React Query: one QueryClient for the page, keyed queries (same key, same data:
// a pool read on the pools list is the one the pool page and the swap page use), shared refetching, and a cache of the
// public data persisted in this browser so a return visit shows it at once while it refreshes.
// Rules, kept here so the screens don't repeat them:
//  - keys start with the network (mode + cluster), so the Sandbox, devnet and mainnet never share an entry;
//  - account-specific data (`account: true`) also carries the connected account and is never persisted: a wallet switch
//    never shows the previous account's data, and nothing about a user is written to this browser's storage;
//  - only queries marked `persist` (public chain and market data) are written to storage;
//  - polling (`intervalMs`) pauses while the tab is hidden or an action is running; invalidate() after an action, and the
//    Sandbox chain moving, refetch every active query (<QuerySync/>);
//  - a loader may `emit` partial results while it runs (rows fill in as they are read); they show until the first full
//    result lands and never replace one.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { QueryClient, keepPreviousData, useQuery, type Query, type QueryKey } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { session, useSession } from './session';
import { storage } from '@/lib/storage';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, gcTime: 30 * 60_000, retry: 1, refetchOnWindowFocus: true, refetchIntervalInBackground: false } },
});

// ---------------------------------------------------------------- persistence (public data only)
const PERSIST_KEY = 'veyl:query-cache', PERSIST_MAX_AGE = 60 * 60_000, BUSTER = 'v1';
/// JSON with bigints (amounts, raw figures) kept exact: stored as { $b: "…" }.
const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $b: x.toString() } : x));
const fromJson = (s: string) => JSON.parse(s, (_k, x) => (x && typeof x === 'object' && typeof x.$b === 'string' && Object.keys(x).length === 1 ? BigInt(x.$b) : x));
const kv = { getItem: (k: string) => storage.getRaw(k), setItem: (k: string, v: string) => storage.setRaw(k, v), removeItem: (k: string) => storage.remove(k) };
const persister = createSyncStoragePersister({ storage: typeof window !== 'undefined' ? kv : undefined, key: PERSIST_KEY, serialize: toJson, deserialize: fromJson, throttleTime: 2000 });

/// The provider for the app: the client, the persisted cache (only queries with meta.persist), and <QuerySync/>.
export function QueryProvider({ children }: { children: ReactNode }) {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: PERSIST_MAX_AGE, buster: BUSTER,
      dehydrateOptions: { shouldDehydrateQuery: (q) => q.meta?.persist === true && q.state.status === 'success' } }}>
      <QuerySync />{children}
    </PersistQueryClientProvider>
  );
}

/// invalidate() (after every action, an account change, the RPC coming back) and the Sandbox chain moving refetch every
/// active query. A fetch already running is never cancelled (a read slower than the refresh rate would never land: the
/// Sandbox chain moves every second); it runs once more when it ends, so what it shows is never older than the refresh.
const again = new Set<Query>();
function refreshActive() {
  queryClient.invalidateQueries({ refetchType: 'none' }); // everything stale: inactive queries refetch when next shown
  for (const q of queryClient.getQueryCache().getAll()) {
    if (!q.isActive() || q.isDisabled()) continue;
    if (q.state.fetchStatus === 'fetching') again.add(q); else q.fetch().catch(() => { /* shown as the query's error */ });
  }
}
queryClient.getQueryCache().subscribe((e) => {
  if (e.type !== 'updated' || !again.has(e.query) || e.query.state.fetchStatus === 'fetching') return;
  again.delete(e.query); if (e.query.isActive()) e.query.fetch().catch(() => {});
});
function QuerySync() {
  const version = useSession((s) => s.version), tick = useSession((s) => s.tick);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } refreshActive(); }, [version, tick]);
  return null;
}

// ---------------------------------------------------------------- keys
/// The network a key belongs to: the engine's mode and cluster.
export function networkKey(): string {
  const rt = session.get().rt; if (!rt) return 'none';
  return rt.mode + ':' + String((rt.cfg as { cluster?: string } | null)?.cluster || rt.chainName || '');
}
/// The full key of a query: network, then the account when account-specific, then the query's own parts.
export const fullKey = (key: readonly unknown[], account?: boolean): QueryKey =>
  account ? [networkKey(), 'acct:' + (session.get().account || '-'), ...key] : [networkKey(), ...key];

// ---------------------------------------------------------------- chain data
export type Emit<T> = (partial: T) => void;
export interface Resource<T> { data: T; loading: boolean; fetching: boolean; error: string | null; updatedAt: number }
export interface ChainQueryOptions<T> {
  initial: T;
  intervalMs?: number;        // poll while visible and idle
  staleMs?: number;           // how long an answer counts as fresh (default 10 s)
  account?: boolean;          // account-specific: the account joins the key; never persisted
  persist?: boolean;          // public data, written to this browser's storage
  keepPrevious?: boolean;     // while a new key loads, keep showing the previous key's data (default: on unless account)
  placeholder?: () => T | undefined; // shown until the first answer (e.g. the same pool from the list's read)
}

/// Data read from the engine (chain, relayer, market), cached under `key`. `load` null: disabled (shows `initial`).
export function useChainQuery<T>(key: readonly unknown[], load: ((emit: Emit<T>) => Promise<T>) | null, o: ChainQueryOptions<T>): Resource<T> {
  useSession((s) => s.rt); useSession((s) => (o.account ? s.account : null)); // re-render (new key) when the network or account changes
  const qk = fullKey(key, o.account), partialKey = [...qk, '~partial'];
  const loader = useRef(load); loader.current = load;
  const enabled = !!load;
  const q = useQuery<T>({
    queryKey: qk, enabled,
    queryFn: async () => { const f = loader.current; if (!f) throw new Error('disabled'); return f((d) => queryClient.setQueryData(partialKey, d)); },
    refetchInterval: o.intervalMs ? () => (session.get().busy ? false : o.intervalMs!) : false,
    staleTime: o.staleMs ?? 10_000,
    placeholderData: (o.keepPrevious ?? !o.account) ? keepPreviousData : undefined,
    meta: { persist: !!o.persist && !o.account },
  });
  const partial = useQuery<T | null>({ queryKey: partialKey, queryFn: () => null, enabled: false, staleTime: Infinity, gcTime: 60_000 });
  const data = q.data !== undefined ? q.data : partial.data ?? (enabled ? o.placeholder?.() : undefined) ?? o.initial;
  return { data, loading: enabled && q.isPending, fetching: q.isFetching, error: q.error ? String(q.error.message || q.error) : null, updatedAt: q.dataUpdatedAt };
}

// ---------------------------------------------------------------- computed values (quotes, previews, lookups)
/// A debounced async computation of some inputs (a quote, a preview, a token check), cached by `scope` + inputs. While new
/// inputs compute, the last answer stays (with `key` saying which inputs it was for); null before the first answer and
/// when there is nothing to compute. Errors read as null.
export function useAsyncQuery<T>(scope: string, compute: (() => Promise<T>) | null, deps: readonly unknown[], delayMs = 0, { staleMs = 15_000, account = false } = {}): { value: T | null; key: string | null } {
  const key = JSON.stringify(deps, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const debounced = useDebounced(compute ? key : null, delayMs);
  const fn = useRef(compute); fn.current = compute;
  const lastKey = useRef<string | null>(null);
  const q = useQuery<T | null>({
    queryKey: fullKey(['calc', scope, debounced], account), enabled: !!compute && debounced === key,
    queryFn: async () => { const f = fn.current; if (!f) return null; try { return await f(); } catch { return null; } },
    staleTime: staleMs, gcTime: 5 * 60_000, retry: 0, placeholderData: keepPreviousData,
  });
  if (!compute) return { value: null, key: null };
  if (q.data !== undefined && !q.isPlaceholderData) lastKey.current = debounced;
  return { value: q.data ?? null, key: q.data !== undefined ? lastKey.current : null };
}

/// `value`, once it has stayed the same for `ms` (immediately when ms is 0).
export function useDebounced<V>(value: V, ms: number): V {
  const [v, setV] = useState(value);
  useEffect(() => { if (!ms) { setV(value); return; } const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return ms ? v : value;
}
