'use client';
// The pool page's price chart: candles (or a line of closes) with volume, at 5 minutes to 1 day. Candles come from the
// relayer's trade index for every pool at once (one request per resolution, so it can't tell which pool is open), as bin
// ids priced here with the pool's own state; volume in dollars when the second token has a market price, else in it.
// Without an index (the Sandbox, an older relayer) the candles are built from the trades in the pool's own figures.
import { CandleChart, fillCandles, type Candle, type ChartMode } from '@/components/charts/CandleChart';
import { Segmented } from '@/components/ui/primitives';
import { engine, usdOf, useSession } from '@/features/session/session';
import { useChainQuery } from '@/features/session/query';
import { createStore, useStore } from '@/lib/store';
import { storage } from '@/lib/storage';
import { usd, tiny } from '@/lib/format';
import { tl } from '@/features/pools/label';
import type { PoolView } from '@/lib/veyl/services/pools';

const RES = [{ value: '300', label: '5m' }, { value: '900', label: '15m' }, { value: '3600', label: '1H' }, { value: '14400', label: '4H' }, { value: '86400', label: '1D' }];
const MODES = [{ value: 'candles', label: 'Candles' }, { value: 'line', label: 'Line' }];
const ui = createStore<{ res: number; mode: ChartMode }>(storage.get('veyl:chart', { res: 900, mode: 'candles' as ChartMode }));
const setUi = (p: Partial<{ res: number; mode: ChartMode }>) => { ui.set(p); storage.set('veyl:chart', ui.get()); };

/// Candles from the trades in the pool's figures (prices per swap): the fallback without a relayer index.
function fromTrades(p: PoolView, res: number): Candle[] {
  const v = p.stats?.spark || [], t = p.stats?.sparkT || []; const out: Candle[] = [];
  for (let i = 0; i < v.length; i++) { const b = t[i] - (t[i] % res); const k = out[out.length - 1];
    if (!k || k.t !== b) out.push({ t: b, o: k ? k.c : v[i], h: Math.max(k ? k.c : v[i], v[i]), l: Math.min(k ? k.c : v[i], v[i]), c: v[i], v: null });
    else { k.h = Math.max(k.h, v[i]); k.l = Math.min(k.l, v[i]); k.c = v[i]; } }
  return out;
}

export function PriceChart({ pool: p }: { pool: PoolView }) {
  const { res, mode } = useStore(ui, (s) => s);
  const live = useSession((s) => !!s.rt?.engine?.poolCandles && s.rpc !== 'down');
  const q = useChainQuery(['candles', res], live ? () => engine().poolCandles!(res) : null, { initial: null, intervalMs: 30_000, staleMs: 20_000, persist: true });
  const E = useSession((s) => s.rt?.engine) || null;
  const rows = q.data?.pools[p.address || ''];
  const uy = usdOf(p.y);
  let candles: Candle[] = [];
  if (E && p.st && rows?.length) {
    const px = (id: number) => E.humanPrice(p.st!, id);
    candles = fillCandles(rows.map(([t, o, h, l, c, vx, vy]) => { const close = px(c); const inY = E.fmt(p.x, BigInt(vx)) * close + E.fmt(p.y, BigInt(vy));
      return { t, o: px(o), h: px(h), l: px(l), c: close, v: uy != null ? inY * uy : inY }; }), res);
  } else if (!rows) candles = fillCandles(fromTrades(p, res), res);
  const unit = `${tl(p.y)} per ${tl(p.x)}`;
  return (
    <div className="card chartcard" id="pxCard" hidden={!candles.length && !q.loading}>
      <div className="h">
        <b>Price <span className="dim" style={{ fontWeight: 400, fontSize: '12.5px' }}>{unit}</span></b>
        <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Segmented className="seg sm" label="Chart type" value={mode} onChange={(v) => setUi({ mode: v as ChartMode })} options={MODES} />
          <Segmented className="seg sm" label="Candle size" value={String(res)} onChange={(v) => setUi({ res: Number(v) })} options={RES} />
        </span>
      </div>
      {candles.length >= 2
        ? <CandleChart candles={candles} mode={mode} label={`${tl(p.x)}–${tl(p.y)} price, ${RES.find((r) => r.value === String(res))?.label} candles`} formatVolume={(v) => (uy != null ? usd(v) ?? '—' : tiny(v) + ' ' + tl(p.y))} />
        : <div className="empty" style={{ padding: '40px 0', textAlign: 'center' }}>{q.loading ? 'Reading trades…' : 'No trades in this window yet.'}</div>}
    </div>
  );
}
