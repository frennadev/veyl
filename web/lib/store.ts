// Global client state on Zustand: one vanilla store per concern (see features/*/state.ts, the session, the router),
// components subscribe to a slice through a selector and re-render only when that slice changes. Server data (anything
// read from the chain, the relayer or an API) lives in React Query instead (lib/query.ts), never in these stores.
// `get` / `set` are short names for Zustand's getState / setState; set skips the update (and every listener) when nothing
// in the patch changed. Selectors must return primitives or stable references (useSyncExternalStore underneath).
import { createStore as createZustand, type StoreApi } from 'zustand/vanilla';
import { useStore as useZustand } from 'zustand';

export interface Store<T> extends StoreApi<T> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  const api = createZustand<T>()(() => initial);
  return Object.assign(api, {
    get: api.getState,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const s = api.getState(); const p = typeof patch === 'function' ? patch(s) : patch;
      if (Object.keys(p).every((k) => Object.is(s[k as keyof T], p[k as keyof T]))) return;
      api.setState(p);
    },
  });
}

export function useStore<T, S>(store: Store<T>, select: (s: T) => S): S {
  return useZustand(store, select);
}
