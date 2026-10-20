// The maths behind the liquidity panel, as plain functions: range sizing, the distribution about to be added (from the SDK's
// own shapeWeights), volatility from a pool's recent swaps, range presets sized from it, and the position simulator.
import type { EngineShape, PoolState, PoolStats, SdkPort } from '../types';

export type Side = 'both' | 'x' | 'y';
export type Shape = 'spot' | 'curve' | 'bidask';
export const SHAPE_LABEL: Record<Shape, string> = { spot: 'Spot', curve: 'Curve', bidask: 'Bid-Ask' };
export const engineShape = (s: Shape): EngineShape => (s === 'bidask' ? 'bidAsk' : s);

/// The most bins a private (shielded) position holds, and the widest range the panel offers.
export const PRIVATE_MAX_BINS = 16;
export const MAX_BINS = 69;

/// A range of `n` bins as offsets from the active bin: above it for X only, below for Y only, centred for both.
export function rangeFromBins(n: number, side: Side): { lo: number; hi: number } {
  n = Math.max(1, Math.min(MAX_BINS, n | 0));
  if (side === 'x') return { lo: 0, hi: n - 1 };
  if (side === 'y') return { lo: -(n - 1), hi: 0 };
  const h = Math.floor((n - 1) / 2); return { lo: -h, hi: n - 1 - h };
}
export const binIds = (lo: number, hi: number) => Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);

/// What each bin of the range gets: amounts (in Y at the active price) when entered, the shape's weights otherwise.
export function distribution(sdk: SdkPort, ids: number[], active: number, shape: Shape, side: Side, priceAtActive: number, ax: number, ay: number) {
  if (!ids.length) return null;
  const w = sdk.shapeWeights(ids, active, engineShape(shape));
  const real = ax > 0 || ay > 0;
  const sx = w.weightsX.reduce((s, x) => s + x, 0) || 1, sy = w.weightsY.reduce((s, x) => s + x, 0) || 1;
  const vals = ids.map((_, i) => real
    ? (side !== 'y' ? (ax * w.weightsX[i]) / sx * priceAtActive : 0) + (side !== 'x' ? (ay * w.weightsY[i]) / sy : 0)
    : (side !== 'y' ? w.weightsX[i] : 0) + (side !== 'x' ? w.weightsY[i] : 0));
  return { ids, vals, real };
}

// ---------------------------------------------------------------- volatility and presets
export interface Volatility { v: number; real: boolean; n?: number }
/// Daily volatility (a fraction): realized from the pool's recent swaps when there are enough, else typical for its bin step.
export function volatility(stats: PoolStats | null, binStep: number): Volatility {
  const sp = stats?.spark, t = stats?.sparkT;
  if (sp && t && sp.length >= 8) {
    let ss = 0, n = 0;
    for (let i = 1; i < sp.length; i++) { const a = sp[i - 1], b = sp[i]; if (a > 0 && b > 0) { const r = Math.log(b / a); ss += r * r; n++; } }
    const span = t[t.length - 1] - t[0] || 0;
    if (n >= 6 && span >= 3600) { const d = Math.sqrt((ss * 86400) / span); if (isFinite(d) && d > 0) return { v: Math.min(d, 1.5), real: true, n }; }
  }
  const bs = binStep || 10;
  return { v: bs <= 1 ? 0.002 : bs <= 10 ? 0.035 : bs <= 20 ? 0.06 : bs <= 50 ? 0.1 : 0.15, real: false };
}
/// k standard deviations over d days.
export const VOL_PRESETS = [
  { name: 'Tight', k: 1, days: 1, title: '1σ, one day' },
  { name: 'Balanced', k: 2, days: 1, title: '2σ, one day' },
  { name: 'Wide', k: 2, days: 7, title: '2σ, one week' },
];
export const presetMove = (vol: number, k: number, days: number) => k * vol * Math.sqrt(days);
/// Bins on one side of the price to cover a relative move.
export const sideBins = (binStep: number, move: number) => Math.max(1, Math.ceil(Math.log(1 + move) / Math.log(1 + (binStep || 10) / 1e4)));

// ---------------------------------------------------------------- simulator
export interface SimBin { id: number; P: number; X: number; Y: number; V: number }
export interface SimPlan { bins: SimBin[]; ax: number; ay: number; pa: number; hypothetical: boolean }
/// The planned position bin by bin, valued at each bin's own price in Y. Without amounts: a 1,000 (dollars, or Y) position.
export function simPlan(sdk: SdkPort, ids: number[], active: number, shape: Shape, side: Side, price: (id: number) => number, ax: number, ay: number, usdY: number | null): SimPlan | null {
  if (!ids.length) return null;
  const w = sdk.shapeWeights(ids, active, engineShape(shape));
  const sx = w.weightsX.reduce((s, x) => s + x, 0), sy = w.weightsY.reduce((s, x) => s + x, 0), pa = price(active);
  let hypothetical = false;
  if (!(ax > 0 || ay > 0)) {
    hypothetical = true; const tot = 1000 / (usdY || 1);
    const fx = sx > 0 && side !== 'y' ? (sy > 0 && side !== 'x' ? 0.5 : 1) : 0; ax = (fx * tot) / pa; ay = (1 - fx) * tot;
  }
  const bins = ids.map((id, i) => { const P = price(id), X = sx > 0 ? (ax * w.weightsX[i]) / sx : 0, Y = sy > 0 ? (ay * w.weightsY[i]) / sy : 0; return { id, P, X, Y, V: X * P + Y }; });
  return { bins, ax, ay, pa, hypothetical };
}
/// The position's value if the price moves to P1 (bins crossed on the way convert at their own price), next to holding.
export function simAt(m: SimPlan, P1: number): { pos: number; hold: number } {
  let v = 0;
  for (const b of m.bins) { if (b.P < P1) v += b.V; else if (b.P > P1) v += (b.V / b.P) * P1; else v += b.X * P1 + b.Y; }
  return { pos: v, hold: m.ax * P1 + m.ay };
}
/// Fees a day in dollars for this plan: the pool's LP fees over the interval, shared with the liquidity in the bins the price
/// actually traded through. Null without trading history or prices.
export function simFeesPerDay(m: SimPlan, st: PoolState, stats: PoolStats | null, ivSecs: number, binValue: (id: number) => number, binFor: (price: number) => number): number | null {
  if (!stats || stats.lpFeesUsd == null || stats.spark.length < 2) return null;
  const ids = stats.spark.map(binFor); const t0 = Math.min(...ids), t1 = Math.max(...ids);
  let share = 0, n = 0;
  for (let id = t0; id <= t1; id++) { const pool = st.bins[id] ? binValue(id) : 0; const me = m.bins.find((b) => b.id === id)?.V || 0; share += me > 0 ? me / (pool + me) : 0; n++; }
  return stats.lpFeesUsd * (86400 / ivSecs) * (n ? share / n : 0);
}
