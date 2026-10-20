'use client';
// Price charts on TradingView's Lightweight Charts (Apache-2.0; its attribution logo stays on, as its licence asks):
// candles with volume underneath, or a line of closes. Themed from the site's CSS tokens (black, green for up, red for
// down, hairline axes, no grid), sized to its container, with a crosshair that reads out the candle under it.
import { useEffect, useRef, useState } from 'react';
import {
  AreaSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineStyle, createChart,
  type IChartApi, type ISeriesApi, type MouseEventParams, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { tiny } from '@/lib/format';

/// One candle: its start (unix seconds), open, high, low, close, and its volume (any unit, or null).
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number | null }
export type ChartMode = 'candles' | 'line';

const css = (name: string, fallback: string) => {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
};
/// `#rrggbb` (or any CSS color the canvas understands) at `a` opacity.
const alpha = (color: string, a: number) => {
  const m = /^#([0-9a-f]{6})$/i.exec(color); if (!m) return color;
  const n = parseInt(m[1], 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export function CandleChart({ candles, mode = 'candles', height = 300, formatVolume, label }: {
  candles: Candle[]; mode?: ChartMode; height?: number; formatVolume?: (v: number) => string; label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{ candles: ISeriesApi<'Candlestick'>; line: ISeriesApi<'Area'>; volume: ISeriesApi<'Histogram'> } | null>(null);
  const [hover, setHover] = useState<Candle | null>(null);
  const byTime = useRef(new Map<number, Candle>());

  // the chart, once
  useEffect(() => {
    if (!box.current) return;
    const up = css('--good', '#C8F560'), down = css('--bad', '#FF6B5E'), muted = css('--muted', '#8A8F86'), line = css('--line', '#22251F');
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: muted, fontFamily: '"IBM Plex Mono", ui-monospace, monospace', fontSize: 11, attributionLogo: true },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { borderColor: line, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false, rightOffset: 2, fixLeftEdge: true },
      crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: muted, style: LineStyle.Dotted, labelBackgroundColor: line }, horzLine: { color: muted, style: LineStyle.Dotted, labelBackgroundColor: line } },
      localization: { priceFormatter: (p: number) => tiny(p) },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    const priceFormat = { type: 'custom' as const, formatter: (p: number) => tiny(p), minMove: 1e-12 };
    const s = {
      candles: c.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down, priceFormat, priceLineVisible: true, priceLineStyle: LineStyle.Dashed }),
      line: c.addSeries(AreaSeries, { lineColor: up, topColor: alpha(up, 0.18), bottomColor: alpha(up, 0), lineWidth: 2, priceFormat, visible: false }),
      volume: c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }),
    };
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    const onMove = (e: MouseEventParams<Time>) => setHover(e.time != null ? byTime.current.get(e.time as number) ?? null : null);
    c.subscribeCrosshairMove(onMove);
    chart.current = c; series.current = s;
    return () => { c.unsubscribeCrosshairMove(onMove); c.remove(); chart.current = null; series.current = null; };
  }, []);

  // its data
  useEffect(() => {
    const s = series.current; if (!s) return;
    const up = css('--good', '#C8F560'), down = css('--bad', '#FF6B5E');
    byTime.current = new Map(candles.map((k) => [k.t, k]));
    const t = (k: Candle) => k.t as UTCTimestamp;
    s.candles.setData(candles.map((k) => ({ time: t(k), open: k.o, high: k.h, low: k.l, close: k.c })));
    s.line.setData(candles.map((k) => ({ time: t(k), value: k.c })));
    s.volume.setData(candles.map((k) => ({ time: t(k), value: k.v ?? 0, color: alpha(k.c >= k.o ? up : down, 0.35) })));
    s.candles.applyOptions({ visible: mode === 'candles' }); s.line.applyOptions({ visible: mode === 'line' });
    chart.current?.timeScale().fitContent();
  }, [candles, mode]);

  const k = hover || candles[candles.length - 1] || null;
  const chg = k && k.o > 0 ? (k.c / k.o - 1) * 100 : null;
  return (
    <div className="lwc" style={{ position: 'relative' }}>
      <div className="lwc-read" aria-live="off">
        {k && <>
          <span>O <b>{tiny(k.o)}</b></span><span>H <b>{tiny(k.h)}</b></span><span>L <b>{tiny(k.l)}</b></span><span>C <b>{tiny(k.c)}</b></span>
          {chg != null && <span className={chg >= 0 ? 'up' : 'dn'}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>}
          {k.v != null && formatVolume && <span>Vol <b>{formatVolume(k.v)}</b></span>}
        </>}
      </div>
      <div ref={box} role="img" aria-label={label} style={{ height }} />
    </div>
  );
}

/// Candles at `res` seconds covering [from, to], gaps filled with flat candles at the last close (so time reads evenly).
export function fillCandles(rows: Candle[], res: number, to = Math.floor(Date.now() / 1000)): Candle[] {
  if (!rows.length) return [];
  const out: Candle[] = []; const end = to - (to % res); let i = 0, last = rows[0].o;
  for (let t = rows[0].t; t <= end; t += res) {
    if (i < rows.length && rows[i].t === t) { out.push(rows[i]); last = rows[i].c; i++; }
    else out.push({ t, o: last, h: last, l: last, c: last, v: 0 });
    if (out.length > 2000) break; // a sane cap for the widest span
  }
  return out;
}
