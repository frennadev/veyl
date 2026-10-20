// Number, time and address formatting shared by every screen. Same output as site/app.js (tiny, pct, age, short).
const SUBS = '₀₁₂₃₄₅₆₇₈₉';

/// A compact amount: 1.25M, 12,340, 1.2345, 0.01234, or 0.0₅123 for very small values.
export function tiny(n: number): string {
  if (!isFinite(n) || n <= 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  if (n >= 0.001) return String(+n.toPrecision(4));
  const z = -Math.floor(Math.log10(n)) - 1;
  const d = String(Math.round(n * Math.pow(10, z + 4))).slice(0, 4).replace(/0+$/, '') || '0';
  return '0.0' + String(z).split('').map((c) => SUBS[+c]).join('') + d;
}
/// A fee in pips (1e-4 %): 0.05%, 0.123%.
export const pct = (pips: number): string => (pips / 1e4).toFixed(pips < 1000 ? 3 : 2).replace(/0$/, '') + '%';
/// A percentage that may be missing.
export const pctOrNull = (v: number | null | undefined): string | null =>
  v == null ? null : (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + '%';
export const usd = (v: number | null | undefined): string | null => (v == null || !isFinite(v) ? null : '$' + tiny(v));
/// Elapsed time: 12s, 4m, 3h, 2d.
export function age(ms: number): string {
  const s = Math.max(0, (ms / 1000) | 0); if (s < 60) return s + 's';
  const m = (s / 60) | 0; if (m < 60) return m + 'm';
  const h = (m / 60) | 0; if (h < 24) return h + 'h';
  return ((h / 24) | 0) + 'd';
}
/// A pool's age: 3d 4h, 5h 12m, 7m.
export function ageLong(sec: number | null | undefined): string | null {
  if (sec == null) return null; const m = (sec / 60) | 0, h = (m / 60) | 0, d = (h / 24) | 0;
  return d ? d + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + (m % 60) + 'm' : m + 'm';
}
export const short = (a: string): string => a.slice(0, 4) + '…' + a.slice(-4);
/// Keeps digits and one dot, as the amount fields do; returns the cleaned text and its value.
export function cleanAmount(text: string): { text: string; value: number } {
  const c = text.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
  return { text: c, value: parseFloat(c) || 0 };
}
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const VEYL_ADDRESS = /^veyl:[1-9A-HJ-NP-Za-km-z]{80,96}$/;
