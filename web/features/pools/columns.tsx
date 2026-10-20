'use client';
// The pools table's columns, as data: a new column is one entry here (label, optional sort key, cell). The table, the
// column picker and the phone cards all read this list.
import type { ReactNode } from 'react';
import { Dash, OrDash, Skeleton } from '@/components/ui/primitives';
import type { Term } from '@/lib/glossary';
import { ageLong, pct, pctOrNull, tiny, usd } from '@/lib/format';
import { liquidityInY, priceOf, type PoolView, type SortKey } from '@/lib/veyl/services/pools';
import type { Mode, UnitsPort, PoolReadPort } from '@/lib/veyl/types';
import { tl } from '@/features/pools/label';

export type ColumnId = 'chart' | 'age' | 'price' | 'apr' | 'fpt' | 'liq' | 'vol' | 'fee' | 'bs';
export const DEFAULT_COLUMNS: ColumnId[] = ['chart', 'age', 'price', 'apr', 'fpt', 'liq', 'vol', 'fee'];

export interface CellCtx {
  mode: Mode; ivLabel: string;
  E: (UnitsPort & PoolReadPort) | null;
  usdOf: (sym: string) => number | null;
}
/// `term`: the glossary entry explained by a tooltip in the column's header.
interface Column { id: ColumnId; name: string; label?: (c: CellCtx) => string; sort?: SortKey; term?: Term; cell: (p: PoolView, c: CellCtx) => ReactNode }

/// A figure that needs the pool's state: a skeleton while it loads, the dash once it failed or can't be read.
const needsState = (p: PoolView, c: CellCtx, v: () => ReactNode): ReactNode =>
  p.st ? v() : c.E && !p.err ? <Skeleton width={56} style={{ marginLeft: 'auto' }} /> : <Dash />;
const fromStats = (p: PoolView, c: CellCtx, v: (s: NonNullable<PoolView['stats']>) => ReactNode) => (p.stats ? v(p.stats) : needsState(p, c, () => <Dash />));
const Sub = ({ children }: { children: ReactNode }) => <span className="sub">{children}</span>;
const inY = (p: PoolView, v: number) => <>{tiny(v)} <span className="dim">{tl(p.y)}</span></>;

export function Change({ c }: { c: number | null | undefined }) {
  if (c == null) return null;
  return <span className={c >= 0.005 ? 'up' : c <= -0.005 ? 'dn' : 'dim'}>{c >= 0 ? '+' : ''}{c.toFixed(2)}%</span>;
}

export function Spark({ vals, className }: { vals: number[] | null | undefined; className?: string }) {
  if (!vals || vals.length < 2) return <Dash />;
  const W = 100, H = 28, mn = Math.min(...vals), mx = Math.max(...vals), r = mx - mn || mx * 1e-4 || 1;
  const d = 'M' + vals.map((v, i) => `${((i / (vals.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - mn) / r) * (H - 4)).toFixed(1)}`).join('L');
  const col = vals[vals.length - 1] >= vals[0] ? 'var(--good)' : 'var(--bad)';
  return (
    <svg className={'spk' + (className ? ' ' + className : '')} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="ar" d={`${d}L${W},${H}L0,${H}Z`} fill={col} /><path d={d} stroke={col} />
    </svg>
  );
}

/// Liquidity: dollars when known (with depth near the price; `compact` leaves that line out, for the phone cards), else the
/// pool's reserves in its second token.
export function liquidityCell(p: PoolView, c: CellCtx, compact = false): ReactNode {
  if (!c.E) return <Dash />;
  if (c.mode === 'sandbox' && p.st) { const r = c.usdOf(p.y), v = liquidityInY(c.E, p); return r != null ? <OrDash v={usd(v * r)} /> : inY(p, v); }
  if (p.stats?.tvlUsd != null) return <>{usd(p.stats.tvlUsd)}{!compact && p.stats.depth != null && <Sub>{Math.round(p.stats.depth * 100)}% within ±10 bins</Sub>}</>;
  // before the figures land: the same dollars they compute (reserves at market prices), from the state alone
  if (p.liqUsd != null) return usd(p.liqUsd);
  return needsState(p, c, () => inY(p, liquidityInY(c.E!, p)));
}

export const COLUMNS: Column[] = [
  { id: 'chart', name: 'Chart', label: (c) => 'Price ' + c.ivLabel, cell: (p, c) => fromStats(p, c, (s) => <><Spark vals={s.spark} /><Sub><Change c={s.change} /></Sub></>) },
  { id: 'age', name: 'Age', sort: 'age', cell: (p, c) => fromStats(p, c, (s) => <OrDash v={ageLong(s.ageSec)} />) },
  { id: 'price', name: 'Price', cell: (p, c) => needsState(p, c, () => inY(p, priceOf(c.E!, p) || 0)) },
  { id: 'apr', name: 'APR', label: (c) => 'APR ' + c.ivLabel, sort: 'apr', term: 'apr', cell: (p, c) => fromStats(p, c, (s) => <OrDash v={pctOrNull(s.aprPct)} />) },
  { id: 'fpt', name: 'Fees / TVL', label: (c) => 'Fees / TVL ' + c.ivLabel, sort: 'fpt', term: 'feeTvl', cell: (p, c) => fromStats(p, c, (s) => <OrDash v={pctOrNull(s.feeTvlPct)} />) },
  { id: 'liq', name: 'Liquidity', sort: 'liq', term: 'liquidity', cell: (p, c) => liquidityCell(p, c) },
  { id: 'vol', name: 'Volume', label: (c) => 'Volume ' + c.ivLabel, sort: 'vol', term: 'volume', cell: (p, c) => fromStats(p, c, (s) => <><OrDash v={usd(s.volumeUsd)} /><Sub>{s.swaps} swaps</Sub></>) },
  { id: 'fee', name: 'Fee now', label: (c) => (c.E ? 'Fee now' : 'Base fee'), sort: 'fee', term: 'dynamicFee',
    cell: (p, c) => (!c.E ? p.base.toFixed(2) + '%' : needsState(p, c, () => <>{pct(p.st!.fee)}<Sub>base {p.base.toFixed(2)}%</Sub></>)) },
  { id: 'bs', name: 'Bin step', sort: 'bs', term: 'binStep', cell: (p) => (p.bs / 100).toFixed(2) + '%' },
];

/// The columns shown: the Sandbox and preview have fixed sets (their figures are limited); on a chain, the visitor's choice.
export function visibleColumns(mode: Mode, chosen: ColumnId[]): Column[] {
  const ids: ColumnId[] = mode === 'sandbox' ? ['price', 'liq', 'fee'] : mode === 'preview' ? ['fee'] : chosen;
  return COLUMNS.filter((c) => ids.includes(c.id));
}
