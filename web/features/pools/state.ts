// The pools list's own UI state. Columns and interval persist (same keys as the legacy app); search, filters and sort don't.
import { createStore, useStore } from '@/lib/store';
import { storage } from '@/lib/storage';
import { NO_FILTER, type Interval, type PoolFilter, type SortKey } from '@/lib/veyl/services/pools';
import { DEFAULT_COLUMNS, type ColumnId } from './columns';

export interface PoolsUi { filter: PoolFilter; sort: SortKey; cols: ColumnId[]; iv: Interval }

export const poolsUi = createStore<PoolsUi>({ filter: NO_FILTER, sort: 'liq', cols: DEFAULT_COLUMNS, iv: 86400 });
export const usePoolsUi = () => useStore(poolsUi, (s) => s);

/// Reads the persisted choices; call once on the client.
export function restorePoolsUi() {
  poolsUi.set({ cols: storage.get<ColumnId[]>('veyl:cols', DEFAULT_COLUMNS), iv: storage.get<Interval>('veyl:iv', 86400) });
}
export const setFilter = (patch: Partial<PoolFilter>) => poolsUi.set((s) => ({ filter: { ...s.filter, ...patch } }));
export const setSort = (sort: SortKey) => poolsUi.set({ sort });
export function setInterval_(iv: Interval) { poolsUi.set({ iv }); storage.set('veyl:iv', iv); }
export function setColumns(cols: ColumnId[]) { poolsUi.set({ cols }); storage.set('veyl:cols', cols); }
