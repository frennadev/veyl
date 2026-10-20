'use client';
// The pool page's bin charts, drawn as SVG at their rendered width: the liquidity in each bin around the price (with the
// range about to be added, open orders and an order's target bin), and the panel's mini preview. The price chart is
// PriceChart.tsx (candles).
import { useState } from 'react';
import { useWidth } from '@/components/ui/useWidth';
import { tiny } from '@/lib/format';
import type { PoolMath } from './poolMath';

const MUTED_TEXT = { fill: 'var(--muted)', fontFamily: 'Manrope, system-ui, sans-serif', fontSize: 13 } as const;
const sideColor = (id: number, active: number) => (id < active ? 'var(--y-side)' : id > active ? 'var(--x-side)' : 'var(--act)');

// ---------------------------------------------------------------- liquidity by bin
export interface BinOverlay {
  range?: { lo: number; hi: number };                // absolute bin ids
  preview?: { ids: number[]; vals: number[] } | null; // the shape about to be added
  orderBin?: number | null;                           // a limit order's target bin
  orders?: number[];                                  // bins holding this account's open orders
}
const SPAN = 35;

export function BinChart({ m, message, overlay }: { m: PoolMath | null; message: string; overlay: BinOverlay }) {
  const [ref, W] = useWidth<SVGSVGElement>(600);
  const [hover, setHover] = useState<number | null>(null);
  const H = 220;
  if (!m) return <><svg id="binChart" ref={ref} role="img" viewBox={`0 0 ${W} ${H}`} aria-label="Liquidity in each price bin"><text x={W / 2} y={H / 2} textAnchor="middle" {...MUTED_TEXT}>{message}</text></svg><div className="axis" id="pAxis"></div><div className="readout" id="pRead"></div></>;

  const a = m.st.active, ids = Array.from({ length: 2 * SPAN + 1 }, (_, i) => a - SPAN + i), n = ids.length;
  const gap = Math.max(1, (W / n) * 0.16), bw = (W - gap * (n - 1)) / n, X = (k: number) => k * (bw + gap);
  const vals = ids.map(m.binValue), mx = Math.max(...vals) || 0, top = H - 26;
  const pv = overlay.preview;
  let band = null, line = '';
  if (pv && overlay.range) {
    const k0 = ids.indexOf(Math.max(overlay.range.lo, ids[0])), k1 = ids.indexOf(Math.min(overlay.range.hi, ids[n - 1]));
    if (k0 >= 0 && k1 >= 0) band = <rect x={(X(k0) - gap / 2).toFixed(1)} y="0" width={(X(k1) + bw - X(k0) + gap).toFixed(1)} height={H} fill="var(--wine-tint)" />;
    const pm = Math.max(...pv.vals) || 1;
    pv.ids.forEach((id, i) => { const k = ids.indexOf(id); if (k < 0) return; const y = (H - 4 - (pv.vals[i] / pm) * H * 0.42).toFixed(1); line += (line ? 'V' + y : `M${X(k).toFixed(1)},${y}`) + 'H' + (X(k) + bw).toFixed(1); });
  }
  const ok = overlay.orderBin != null ? ids.indexOf(overlay.orderBin) : -1;
  const hb = hover != null ? m.st.bins[hover] : null;
  const readout = hover == null ? '' : `Bin ${hover}${hover === a ? ' (active)' : ''} · ${tiny(m.price(hover))} ${m.y} · `
    + (hb ? `${m.amt(m.x, hb.x)} ${m.x} + ${m.amt(m.y, hb.y)} ${m.y}` : 'empty')
    + (hb && (hb.askX > 0n || hb.bidY > 0n) ? ` · orders ${m.amt(m.x, hb.askX)} ${m.x} / ${m.amt(m.y, hb.bidY)} ${m.y}` : '');
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect(); setHover(ids[Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left) / (r.width / n))))]);
  };
  return (
    <>
      <svg id="binChart" ref={ref} role="img" viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}
        aria-label="Liquidity in each price bin around the active bin, with the range you are about to add highlighted">
        <g className="bg">{band}</g>
        <g className="bs">{ids.map((id, k) => {
          const h = mx > 0 ? Math.max(vals[k] > 0 ? 2 : 0, (vals[k] / mx) * top) : 0;
          return <rect key={k} className="bar" data-bin={id} x={X(k).toFixed(1)} y={(H - h).toFixed(1)} width={bw.toFixed(1)} height={h.toFixed(1)} fill={sideColor(id, a)} opacity={id === a ? 1 : 0.85} />;
        })}</g>
        <g className="ov">
          <rect x={X(ids.indexOf(a)).toFixed(1)} y="0" width={bw.toFixed(1)} height={H} fill="var(--act)" opacity=".10" />
          {line && <path d={line} fill="none" stroke="var(--wine-2)" strokeWidth="2" strokeLinejoin="round" />}
          {ok >= 0 && <rect x={X(ok).toFixed(1)} y="0" width={bw.toFixed(1)} height={H} fill="none" stroke="var(--wine-2)" strokeWidth="1.5" strokeDasharray="3 3" />}
          {(overlay.orders || []).map((b, i) => { const k = ids.indexOf(b); return k >= 0 ? <circle key={i} cx={(X(k) + bw / 2).toFixed(1)} cy="8" r="3.5" fill="var(--wine-2)" /> : null; })}
          {!(mx > 0) && <text x={W / 2} y={H / 2 - 10} textAnchor="middle" {...MUTED_TEXT}>No liquidity in these bins yet</text>}
        </g>
      </svg>
      <div className="axis" id="pAxis"><span>{tiny(m.price(ids[0]))}</span><span>{tiny(m.price(a))} {m.y}</span><span>{tiny(m.price(ids[n - 1]))}</span></div>
      <div className="readout" id="pRead">{readout}</div>
    </>
  );
}

// ---------------------------------------------------------------- the panel's mini preview
export function MiniPreview({ dist, active }: { dist: { ids: number[]; vals: number[] } | null; active: number }) {
  const [ref, W] = useWidth<SVGSVGElement>(360);
  const H = 46;
  if (!dist) return <svg id="mini" ref={ref} aria-hidden="true" />;
  const n = dist.ids.length, gap = n > 40 ? 1 : 2, bw = Math.max(1, (W - gap * (n - 1)) / n), mx = Math.max(...dist.vals) || 1;
  return (
    <svg id="mini" ref={ref} aria-hidden="true" viewBox={`0 0 ${W} ${H}`}>
      {dist.ids.map((id, i) => { const h = Math.max(dist.vals[i] > 0 ? 2 : 0, (dist.vals[i] / mx) * (H - 4));
        return <rect key={i} x={(i * (bw + gap)).toFixed(1)} y={(H - h).toFixed(1)} width={bw.toFixed(1)} height={h.toFixed(1)} fill={sideColor(id, active)} />; })}
    </svg>
  );
}
