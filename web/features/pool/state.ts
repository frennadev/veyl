// The pool page's panel state: tab, where the money comes from, the range (as offsets from the active bin, so it follows
// the price), shape, and what's typed in each tab. Amounts reset when another pool opens.
import { createStore, useStore } from '@/lib/store';
import { rangeFromBins, type Shape, type Side } from '@/lib/veyl/services/liquidity';

export type Tab = 'add' | 'zap' | 'limit' | 'swap';
export type Source = 'priv' | 'pub';
export interface PanelState {
  pool: string | null; tab: Tab; src: Source; side: Side; shape: Shape; lo: number; hi: number;
  amtX: string; amtY: string; zapX: boolean; zapAmt: string; buy: boolean; ordPrice: string; ordAmt: string; swapX: boolean; swapIn: string;
  swMode: 'sealed' | 'instant' | null;   // the Swap tab's mode where the pool has sealed batches (null: sealed)
  preset: number | null;  // the range preset (an index into VOL_PRESETS, sized from the pool's volatility); null: a range set by hand
  more: boolean;          // "More options" open: shape, exact range, bin presets, preview and simulator
  sheet: boolean;   // the panel as a bottom sheet on phones
}
const AMOUNTS = { amtX: '', amtY: '', zapAmt: '', ordPrice: '', ordAmt: '', swapIn: '' };

export const panel = createStore<PanelState>({
  pool: null, tab: 'add', src: 'priv', side: 'both', shape: 'spot', lo: -5, hi: 5, zapX: false, buy: true, swapX: true, swMode: null, sheet: false, preset: 1, more: false, ...AMOUNTS,
});
export const usePanel = () => useStore(panel, (s) => s);
export const setPanel = (p: Partial<PanelState>) => panel.set(p);

export function enterPool(id: string) { if (panel.get().pool !== id) panel.set({ pool: id, sheet: false, ...AMOUNTS }); }
export const clearAmounts = () => panel.set({ ...AMOUNTS, sheet: false });
/// Sets the range to `n` bins on the current side.
export const setBins = (n: number) => panel.set((s) => rangeFromBins(n, s.side));
/// A range chosen by hand (bin presets, min/max/bins fields): the volatility preset no longer drives it.
export const setCustomBins = (n: number) => panel.set((s) => ({ preset: null, ...rangeFromBins(n, s.side) }));
export const openSheet = (tab: Tab) => panel.set({ tab, sheet: true });
