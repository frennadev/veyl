'use client';
// Pieces the panel's tabs share: the amount box, the details list, "who sees what", the shape + range section (with presets,
// volatility-sized presets, the mini preview) and the position simulator.
import { tl } from '@/features/pools/label';
import { useState, type ReactNode } from 'react';
import { TokenLogo, Tip } from '@/components/ui/primitives';
import type { Term } from '@/lib/glossary';
import { toast } from '@/components/overlay';
import { cleanAmount, maxAmount, tiny } from '@/lib/format';
import {
  MAX_BINS, PRIVATE_MAX_BINS, SHAPE_LABEL, VOL_PRESETS, presetMove, sideBins, simAt, simFeesPerDay, volatility, type Shape, type SimPlan,
} from '@/lib/veyl/services/liquidity';
import type { PoolStats } from '@/lib/veyl/types';
import { MiniPreview } from '../charts';
import { priceInput, type PoolMath } from '../poolMath';
import { panel, setBins, setPanel, usePanel } from '../state';

// ---------------------------------------------------------------- amounts
export interface AmountIds { box?: string; input: string; tk: string; left: string; bal: string; max: string }
/// app.css's .amt box: the input with its token, a left note (hint or preview), the balance and Max.
export function AmountBox({ ids, sym, value, onChange, left, balance, onMax, hidden, label }:
  { ids: AmountIds; sym: string; value: string; onChange: (v: string) => void; left?: ReactNode; balance: string; onMax: () => void; hidden?: boolean; label: string }) {
  return (
    <div className="amt" id={ids.box} hidden={hidden}>
      <div className="m">
        <input id={ids.input} type="text" inputMode="decimal" placeholder="0" autoComplete="off" aria-label={label} value={value} onChange={(e) => onChange(cleanAmount(e.target.value).text)} />
        <span className="tk" id={ids.tk}><TokenLogo sym={sym} className="" />{tl(sym)}</span>
      </div>
      <div className="b"><span id={ids.left}>{left}</span><span><span className="sens" id={ids.bal}>{balance}</span><button type="button" id={ids.max} onClick={onMax}>Max</button></span></div>
    </div>
  );
}
/// Max uses the full balance without display rounding.
export const maxText = maxAmount;

/// A detail row: label, value, and optionally the glossary term its label explains.
export type Detail = [string, ReactNode, Term?];
export const Details = ({ rows }: { rows: Detail[] }) => <dl className="det" id="actDet">{rows.map(([k, v, t]) => <div key={k}><dt>{k}{t && <Tip term={t} align="l" />}</dt><dd>{v}</dd></div>)}</dl>;
export interface SeenText { hidden: string; pub: string }
export const Seen = ({ s }: { s: SeenText | null }) => (
  <div className="seen" id="actSeen">{s && <><div className="h"><b>Hidden<Tip term="seen" align="l" /></b><span>{s.hidden}</span></div><div className="p"><b>Public</b><span>{s.pub}</span></div></>}</div>
);

// ---------------------------------------------------------------- range
/// A price or bin-count field that shows the live value and applies what's typed on Enter or leaving the field.
function DraftInput({ id, label, shown, numeric, onApply, tip }: { id: string; label: string; shown: string; numeric?: boolean; onApply: (v: string) => void; tip?: Term }) {
  const [draft, setDraft] = useState<string | null>(null);
  const apply = () => { if (draft != null) onApply(draft); setDraft(null); };
  return (
    <label><span>{label}{tip && <Tip term={tip} align="r" />}</span>
      <input id={id} type="text" inputMode={numeric ? 'numeric' : 'decimal'} autoComplete="off" value={draft ?? shown} placeholder={shown ? undefined : '—'}
        onFocus={() => setDraft(shown)} onChange={(e) => setDraft(cleanAmount(e.target.value).text)} onBlur={apply}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

const SHAPE_ICONS: Record<Shape, string> = {
  spot: 'M4 7h44v13H4z', curve: 'M4 20C14 20 18 2 26 2s12 18 22 18Z', bidask: 'M4 2c8 0 14 18 22 18s14-18 22-18v18H4Z',
};
const WIDTH_PRESETS: [string, string][] = [['5', '11 bins'], ['7', '15 bins'], ['20', '41 bins'], ['34', '69 bins'], ['c', 'Re-centre']];

/// Shape, price range, presets and the preview, shared by Add and Zap.
export function ShapeRange({ m, stats, binStep, dist, children }: { m: PoolMath | null; stats: PoolStats | null; binStep: number; dist: { ids: number[]; vals: number[] } | null; children?: ReactNode }) {
  const s = usePanel();
  const a = m?.st.active ?? 0, lo = a + s.lo, hi = a + s.hi, n = s.hi - s.lo + 1;
  const applyPrice = (which: 'lo' | 'hi') => (v: string) => {
    if (!m) return; const p = parseFloat(v); if (!(p > 0)) return; const off = m.binFor(p) - a;
    panel.set((x) => { let L = which === 'lo' ? Math.min(off, x.hi) : x.lo, H = which === 'hi' ? Math.max(off, x.lo) : x.hi; if (H - L > MAX_BINS - 1) L = H - (MAX_BINS - 1); return { lo: L, hi: H }; });
  };
  return (
    <div className="list" id="shapeRange" style={{ gap: 12 }}>
      <div className="lbl"><span>Shape<Tip term="shape" align="l" /></span></div>
      <div className="shape" id="shapeSeg" role="group" aria-label="Liquidity shape">
        {(Object.keys(SHAPE_ICONS) as Shape[]).map((k) => (
          <button key={k} type="button" data-s={k} aria-pressed={s.shape === k} onClick={() => setPanel({ shape: k })}>
            <svg viewBox="0 0 52 20"><path d={SHAPE_ICONS[k]} fill="currentColor" opacity=".8" /></svg>{SHAPE_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="lbl"><span>Price range<Tip term="range" align="l" /></span><span id="rngNote">{m ? (lo > a ? 'above the price' : hi < a ? 'below the price' : 'around the price') : ''}</span></div>
      <div className="rng">
        <DraftInput id="rMin" label="Min price" shown={m ? priceInput(m.price(lo)) : ''} onApply={applyPrice('lo')} />
        <DraftInput id="rMax" label="Max price" shown={m ? priceInput(m.price(hi)) : ''} onApply={applyPrice('hi')} />
        <DraftInput id="rBins" label="Bins" numeric tip="bins" shown={String(n)} onApply={(v) => setBins(parseInt(v) || 1)} />
      </div>
      <div className="presets" id="presets">
        {WIDTH_PRESETS.map(([w, l]) => <button key={w} type="button" data-w={w} onClick={() => setBins(w === 'c' ? n : +w * 2 + 1)}>{l}</button>)}
      </div>
      <VolPresets stats={stats} binStep={binStep} />
      <MiniPreview dist={dist} active={a} />
      {children}
    </div>
  );
}

function VolPresets({ stats, binStep }: { stats: PoolStats | null; binStep: number }) {
  const s = usePanel(); const vo = volatility(stats, binStep);
  const pick = (k: number, days: number) => {
    const cap = s.src === 'priv' ? PRIVATE_MAX_BINS : MAX_BINS; let side = sideBins(binStep, presetMove(vo.v, k, days));
    const full = s.side === 'both' ? 2 * side + 1 : side + 1;
    if (full > cap) { side = s.side === 'both' ? Math.floor((cap - 1) / 2) : cap - 1; toast(`Capped at ${cap} bins${cap === PRIVATE_MAX_BINS ? ' (the most a private position holds)' : ''}`, 'alert', 4000); }
    setBins(s.side === 'both' ? 2 * side + 1 : side + 1);
  };
  const fmtPct = (v: number) => (v * 100).toFixed(v < 0.01 ? 2 : 1) + '%';
  return (
    <div className="volpre" id="volPre">
      <div className="vk"><span>Volatility ≈ <b>{fmtPct(vo.v)}</b> a day<Tip term="volatility" align="l" /></span><small>{vo.real ? `from ${vo.n} recent swaps` : 'typical for this pool type'}</small></div>
      <div className="presets">
        {VOL_PRESETS.map((p, i) => { const mv = presetMove(vo.v, p.k, p.days); return <button key={i} type="button" data-vp={i} title={p.title} onClick={() => pick(p.k, p.days)}>{p.name} <small>±{fmtPct(mv)}</small></button>; })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- simulator
const usd2 = (v: number) => (!isFinite(v) ? '—' : '$' + (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : Math.abs(v) >= 1 ? v.toFixed(2) : tiny(v)));
const MOVES = [-30, -15, -5, 5, 15, 30];

export function Simulator({ plan, m, stats, usdY, ivSecs }: { plan: SimPlan | null; m: PoolMath | null; stats: PoolStats | null; usdY: number | null; ivSecs: number }) {
  if (!plan || !m) return <div className="sim" id="simBox"></div>;
  const fmtV = (v: number) => (usdY != null ? usd2(v * usdY) : `${tiny(v)} ${m.y}`);
  const now = simAt(plan, plan.pa).pos, Plo = plan.bins[0].P, Phi = plan.bins[plan.bins.length - 1].P, width = (Phi / Plo - 1) * 100;
  const day = usdY != null ? simFeesPerDay(plan, m.st, stats, ivSecs, m.binValue, m.binFor) : null;
  const apr = day != null && now * (usdY || 0) > 0 ? ((day * 365) / (now * usdY!)) * 100 : null;
  return (
    <div className="sim" id="simBox">
      <div className="sim-h"><b>Simulate<Tip term="simulate" align="l" /></b><small>{plan.hypothetical ? `for a ${usdY != null ? '$1,000' : '1,000 ' + m.y} position` : 'for the amounts above'}</small></div>
      <div className="sim-k">
        <div><span>Range</span><b>{tiny(Plo)} – {tiny(Phi)}</b><small>{width.toFixed(width < 1 ? 2 : 1)}% wide · {plan.bins.length} bins</small></div>
        <div><span>Est. fees<Tip term="estFees" align="r" /></span><b>{day == null ? <span className="dim">Needs trading history</span> : <>{usd2(day)} a day{apr != null && <> · <b>{apr.toFixed(apr < 10 ? 1 : 0)}% APR</b></>}</>}</b><small>at this pool&apos;s recent volume, if the price stays in range</small></div>
      </div>
      <table className="sim-t">
        <thead><tr><th>Price move</th><th>Price</th><th>Position</th><th>vs holding<Tip term="vsHolding" align="r" /></th></tr></thead>
        <tbody>{MOVES.map((d) => {
          const P1 = plan.pa * (1 + d / 100), r = simAt(plan, P1), il = (r.pos / r.hold - 1) * 100;
          return <tr key={d}><td>{d > 0 ? '+' : ''}{d}%</td><td>{tiny(P1)}</td><td>{fmtV(r.pos)}{(P1 < Plo || P1 > Phi) && <> <span className="dim">out</span></>}</td><td className={il < -0.05 ? 'down' : 'dim'}>{il >= 0 ? '+' : ''}{il.toFixed(2)}%</td></tr>;
        })}</tbody>
      </table>
      <small className="dim">Fees not included in the moves. Past volume is no promise of future fees.</small>
    </div>
  );
}
