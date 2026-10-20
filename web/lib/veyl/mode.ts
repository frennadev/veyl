// Which engine the app runs: the Sandbox (?mode=sandbox-dev, remembered) or the deployment. Same rule as site/app.js, so
// switching between /app and /v2 keeps the mode. Whether the deployment exists is decided later, by the runtime config.
import { storage } from '@/lib/storage';

const KEY = 'veyl:mode';
export type ModeRequest = 'sandbox' | 'chain';

export function requestedMode(search: string): ModeRequest {
  let q: string | null = null;
  try { q = new URLSearchParams(search).get('mode'); } catch { /* malformed query */ }
  if (q === 'sandbox-dev' || q === 'devnet') storage.setRaw(KEY, q);
  return (q || storage.getRaw(KEY)) === 'sandbox-dev' ? 'sandbox' : 'chain';
}

/// Remembers the choice; the caller reloads the page (each engine owns the page for its lifetime).
export function rememberMode(m: ModeRequest): void { storage.setRaw(KEY, m === 'sandbox' ? 'sandbox-dev' : 'devnet'); }
