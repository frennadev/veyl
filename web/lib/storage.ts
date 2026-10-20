// localStorage that never throws (private windows, blocked site data): reads fall back to the default, writes are dropped.
// The only place v2 touches localStorage directly; the engine keeps its own store.
export const storage = {
  get<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(key); return v == null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
  },
  set(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
  },
  getRaw(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  setRaw(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key); } catch { /* storage blocked */ }
  },
};
