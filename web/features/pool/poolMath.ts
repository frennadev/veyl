// One pool's price and bin arithmetic, bound to the engine and the pool's current state, so components don't repeat it.
import { tiny } from '@/lib/format';
import type { PoolReadPort, PoolState, Sym, UnitsPort } from '@/lib/veyl/types';

export interface PoolMath {
  st: PoolState; x: Sym; y: Sym;
  price(id: number): number;          // Y per X at bin `id`
  binFor(price: number): number;      // the bin nearest a price
  binValue(id: number): number;       // a bin's liquidity (and resting orders) in Y at its own price
  amt(sym: Sym, v: bigint): string;   // token units, compact
  liquidityInY(): number;
}

export function poolMath(E: UnitsPort & PoolReadPort, st: PoolState): PoolMath {
  const price = (id: number) => E.humanPrice(st, id);
  return {
    st, x: st.x, y: st.y, price,
    binFor: (p) => E.binForPrice(st, p),
    binValue: (id) => { const b = st.bins[id]; return b ? E.fmt(st.x, b.x + b.askX) * price(id) + E.fmt(st.y, b.y + b.bidY) : 0; },
    amt: (sym, v) => tiny(E.fmt(sym, v)),
    liquidityInY: () => E.fmt(st.x, st.reserves.x) * price(st.active) + E.fmt(st.y, st.reserves.y),
  };
}
/// Price text for an input field (no thousands separators).
export const priceInput = (v: number) => tiny(v).replace(/,/g, '');
