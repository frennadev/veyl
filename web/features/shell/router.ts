// Hash routing with the legacy app's hashes (#pools, #pool-sol-usdc, #portfolio, #swap, …, #pay=veyl:…), so every existing
// link into app.html works on v2 unchanged. Like the legacy app it replaces the hash (no history entries per page) and still
// follows hashchange (links, Back).
import { createStore, useStore } from '@/lib/store';

export type PageId = 'pools' | 'pool' | 'swap' | 'home' | 'activity' | 'sealed' | 'markets' | 'privacy' | 'create';
export interface Route { page: PageId; pool: string | null }

const HASH_PAGE: Record<string, PageId> = {
  portfolio: 'home', home: 'home', swap: 'swap', pools: 'pools', activity: 'activity', sealed: 'sealed', markets: 'markets', privacy: 'privacy', create: 'create',
};
export const hashOf = (r: Route): string => (r.page === 'pool' ? 'pool-' + r.pool : r.page === 'home' ? 'portfolio' : r.page);

export const route = createStore<Route>({ page: 'pools', pool: null });
export const useRoute = () => useStore(route, (r) => r);

/// `known(id)` says whether a pool id exists; an unknown pool or hash lands on the pools list.
export function parseHash(hash: string, known: (poolId: string) => boolean): Route {
  const h = hash.replace(/^#/, '');
  if (h.startsWith('pool-') && known(h.slice(5))) return { page: 'pool', pool: h.slice(5) };
  return { page: HASH_PAGE[h] || 'pools', pool: null };
}

export function go(page: PageId, pool: string | null = null) {
  const r = { page, pool: page === 'pool' ? pool : null };
  route.set(r);
  try { history.replaceState(null, '', '#' + hashOf(r)); } catch { /* sandboxed frame */ }
  window.scrollTo({ top: 0 });
}
export const openPool = (id: string) => go('pool', id);
