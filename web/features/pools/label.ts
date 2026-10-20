// A token key as shown to people. Keys are symbols for listed tokens and mint addresses for tokens from pools anyone created
// (open pool creation); the engine's tokLabel turns either into a symbol, or a shortened mint when there is none.
import { session } from '@/features/session/session';

export function tl(k: string): string {
  const E = session.get().rt?.engine as { tokLabel?: (k: string) => string } | null | undefined;
  try { return E?.tokLabel ? E.tokLabel(k) : k; } catch { return k; }
}
