'use client';
// Markets: live pools on other Solana DEXes (never Veyl's own figures), from keyless public APIs read in this browser. Search,
// interval, sort, DEX and filters; a detail drawer with hourly candles, addresses and links; and "mirror on Veyl" requests,
// which only record a request for the owner (pool creation is gated to the factory authority).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fullKey, queryClient, useChainQuery, useDebounced } from '@/features/session/query';
import { CandleChart as LibCandleChart } from '@/components/charts/CandleChart';
import { Dash, Icon, OrDash, Segmented, Tip } from '@/components/ui/primitives';
import { Popover } from '@/components/ui/Popover';
import { useWidth } from '@/components/ui/useWidth';
import { copyText, toast } from '@/components/overlay';
import { session, useSession } from '@/features/session/session';
import { Change } from '@/features/pools/columns';
import { age, ageLong, pctOrNull, short, tiny, usd } from '@/lib/format';
import { storage } from '@/lib/storage';
import { createStore, useStore } from '@/lib/store';
import type { Candle, MarketError, MarketRow } from '@/lib/veyl/types';

type Iv = 'm5' | 'h1' | 'h6' | 'h24';
type Sort = 'vol' | 'liq' | 'fees' | 'apr' | 'chg' | 'age' | 'name';
interface Filters { minLiq: string; fee: string; kind: 'all' | 'dlmm' | 'clmm' }
/// The page's UI state (Zustand); the market data itself is a query (useMarketRows).
interface MarketsUi { q: string; iv: Iv; sort: Sort; dex: string; flt: Filters; open: string | null }
interface MarketData { rows: MarketRow[]; errors: Record<string, MarketError>; at: number }
type MarketsState = MarketsUi & MarketData & { loading: boolean };
const NO_FILTERS: Filters = { minLiq: '0', fee: 'all', kind: 'all' };
const mk = createStore<MarketsUi>({ q: '', iv: 'h24', sort: 'vol', dex: 'all', flt: NO_FILTERS, open: null });

const IVS: Iv[] = ['m5', 'h1', 'h6', 'h24'];
const IV_LABEL: Record<Iv, string> = { m5: '5m', h1: '1h', h6: '6h', h24: '24h' };
const SORTS: [Sort, string][] = [['vol', 'Volume'], ['liq', 'Liquidity'], ['fees', 'Fees 24h'], ['apr', 'APR'], ['chg', 'Change'], ['age', 'Age'], ['name', 'Name']];
const DEXES: [string, string][] = [['all', 'All DEXes'], ['meteora', 'Meteora DLMM'], ['raydium', 'Raydium'], ['orca', 'Orca'], ['pump', 'Pump'], ['other', 'Other']];
const dexClass = (d: string) => (/meteora/i.test(d) ? 'meteora' : /raydium/i.test(d) ? 'raydium' : /orca/i.test(d) ? 'orca' : /pump/i.test(d) ? 'pump' : '');
const FRESH_MS = 45_000, STALE_MS = 5 * 60_000, AUTO_REFRESH_MS = 60_000, SEARCH_MIN = 2, CARDS_MAX = 60;
const srcAge = (r: MarketRow) => { const s = Math.max(0, Math.round((Date.now() - (r.at || 0)) / 1000)); return (r.sources || [r.source]).join(' + ') + ' · ' + (s < 60 ? s + ' s' : Math.round(s / 60) + ' min'); };

// ---------------------------------------------------------------- loading
const NO_DATA: MarketData = { rows: [], errors: {}, at: 0 };
/// The markets list (or, for 2+ characters, a search of the APIs; shorter text filters what's loaded): a query refreshed
/// every minute; the list (public market data) is persisted, so a return visit shows it at once.
function useMarketRows(q: string): MarketData & { loading: boolean; refresh: () => void } {
  const M = useSession((x) => x.rt?.markets?.api);
  const t = q.trim(); const dq = useDebounced(t, t.length >= SEARCH_MIN ? 500 : 300); const search = dq.length >= SEARCH_MIN ? dq : '';
  const key = ['markets', search];
  const r = useChainQuery<MarketData>(key, M ? () => (search ? M.search(search) : M.list({ limit: 100 })) : null, { initial: NO_DATA, intervalMs: AUTO_REFRESH_MS, staleMs: FRESH_MS, persist: !search });
  const errors = r.error && !r.data.rows.length ? { all: { message: r.error } } : r.data.errors;
  return { ...r.data, errors, loading: r.fetching, refresh: () => { queryClient.invalidateQueries({ queryKey: fullKey(key) }); } };
}

function visibleRows(s: MarketsState): MarketRow[] {
  let l = s.rows.slice();
  if (s.dex !== 'all') l = l.filter((r) => dexClass(r.dex) === s.dex || (s.dex === 'other' && !dexClass(r.dex)));
  const minLiq = +s.flt.minLiq || 0; if (minLiq) l = l.filter((r) => (r.liquidityUsd || 0) >= minLiq);
  if (s.flt.kind === 'dlmm') l = l.filter((r) => r.binStep != null);
  if (s.flt.kind === 'clmm') l = l.filter((r) => r.tickSpacing != null || /CLMM/.test(r.dex));
  if (s.flt.fee !== 'all') { const [a, b] = s.flt.fee.split('-').map(Number); l = l.filter((r) => r.feePct != null && r.feePct >= a && r.feePct < b); }
  const q = s.q.trim().toLowerCase(); if (q && q.length < SEARCH_MIN) l = l.filter((r) => (r.pair + ' ' + r.dex).toLowerCase().includes(q));
  const key: Record<Exclude<Sort, 'name'>, (r: MarketRow) => number> = {
    vol: (r) => r.volume[s.iv] ?? r.volume.h24 ?? -1, liq: (r) => r.liquidityUsd ?? -1, fees: (r) => r.feesUsd24h ?? -1, apr: (r) => r.aprPct ?? -1,
    chg: (r) => r.change[s.iv] ?? r.change.h24 ?? -999, age: (r) => r.ageSec ?? -1,
  };
  if (s.sort === 'name') l.sort((a, b) => a.pair.localeCompare(b.pair)); else { const k = key[s.sort]; l.sort((a, b) => k(b) - k(a)); }
  return l;
}

// ---------------------------------------------------------------- page
export default function MarketsPage() {
  const ui = useStore(mk, (x) => x);
  const data = useMarketRows(ui.q);
  const s: MarketsState = useMemo(() => ({ ...ui, rows: data.rows, errors: data.errors, at: data.at, loading: data.loading }), [ui, data.rows, data.errors, data.at, data.loading]);
  const rt = useSession((x) => x.rt);
  const M = rt?.markets;
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) tick((n) => n + 1); }, 15_000); return () => clearInterval(t); }, []); // the "refreshed … ago" line
  const rows = useMemo(() => visibleRows(s), [s]);
  const dexesHere = new Set<string>(s.rows.map((r) => dexClass(r.dex) || 'other'));
  const nFilters = +(+s.flt.minLiq > 0) + +(s.flt.fee !== 'all') + +(s.flt.kind !== 'all');
  const none = !s.rows.length && Object.keys(s.errors).length > 0;
  const ivn = IV_LABEL[s.iv];
  const chgIv = (r: MarketRow) => (r.change[s.iv] != null ? <Change c={r.change[s.iv]} /> : s.iv === 'h24' ? <Dash /> : <span className="dim" title="This source gives 24h only">—</span>);
  const volIv = (r: MarketRow) => (r.volume[s.iv] != null ? <OrDash v={usd(r.volume[s.iv])} /> : s.iv !== 'h24' && r.volume.h24 != null ? <span className="dim" title="This source gives 24h only">—</span> : <OrDash v={usd(r.volume.h24)} />);
  const tier = (r: MarketRow) => (r.binStep != null ? (r.feePct != null ? r.feePct.toFixed(2) + '% · ' : '') + 'bin ' + (r.binStep / 100).toFixed(2) + '%' : r.feePct != null ? r.feePct.toFixed(2) + '%' + (r.tickSpacing != null ? ' · tick ' + r.tickSpacing : '') : '—');
  const filterChips = (k: keyof Filters, vals: string[], fmt: (v: string) => string) => (
    <div className="chips">{vals.map((v) => <button key={v} className="chip" type="button" aria-pressed={s.flt[k] === v} onClick={() => mk.set({ flt: { ...s.flt, [k]: v } })}>{fmt(v)}</button>)}</div>
  );
  return (
    <section className="page" id="pg-markets">
      <div className="ph"><div><h1>Markets</h1><p>Live pools across Solana DEXes. These are not Veyl pools.</p></div></div>
      <div className="extline"><Icon name="globe" size="sm" /><span><b>Solana markets · live · external DEXes<Tip term="marketsExternal" align="l" /></b>{' — not Veyl pools'}</span>
        <span className="srcs" id="mkSrcs" hidden={none}>{M && Object.entries(M.sources).map(([id, src]) => {
          const st = M.api.state[id] || { ok: null }, err = s.errors[id], wait = err?.retryIn ? Math.ceil(err.retryIn / 1000) : 0;
          const cls = st.ok === null ? '' : wait ? 'wait' : st.ok ? 'ok' : 'bad';
          return <span key={id} className={cls} title={src.base}><i></i>{src.name}{wait ? ` · retry in ${wait} s` : st.ok === false ? ' · ' + (st.error || 'down') : st.ok ? '' : ' · …'}</span>;
        })}</span>
      </div>
      <div className="ptools">
        <label className="search"><Icon name="search" /><input id="mkQ" type="text" placeholder="Search pairs or a token symbol" aria-label="Search markets" autoComplete="off" value={s.q} onChange={(e) => mk.set({ q: e.target.value })} /></label>
        <div className="grp">
          <div className="iv" id="mkIv" role="group" aria-label="Interval for volume and change">{IVS.map((v) => <button key={v} type="button" data-iv={v} aria-pressed={s.iv === v} onClick={() => mk.set({ iv: v })}>{IV_LABEL[v]}</button>)}</div>
          <label className="sortl">{'Sort by '}<select className="sel" id="mkSort" aria-label="Sort markets" value={s.sort} onChange={(e) => mk.set({ sort: e.target.value as Sort })}>{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <Popover id="mkFlt" button={<><Icon name="filter" size="sm" />Filters<em id="mkFltN">{nFilters || ''}</em></>}>
            <span className="h">Minimum liquidity</span>{filterChips('minLiq', ['0', '10000', '100000', '1000000'], (v) => (v === '0' ? 'Any' : '$' + tiny(+v)))}
            <span className="h">Fee tier</span>{filterChips('fee', ['all', '0-0.05', '0.05-0.3', '0.3-1', '1-100'], (v) => (v === 'all' ? 'Any' : v.replace('-', ' – ').replace('100', '∞') + '%'))}
            <span className="h">Pool kind</span>{filterChips('kind', ['all', 'dlmm', 'clmm'], (v) => ({ all: 'Any', dlmm: 'Bin (DLMM)', clmm: 'Concentrated' })[v] || v)}
            <div className="foot"><button type="button" onClick={() => mk.set({ flt: NO_FILTERS })}>Clear</button></div>
          </Popover>
          <button className="tbtn" id="mkRefresh" type="button" onClick={data.refresh}>Refresh</button>
        </div>
      </div>
      <div className="chips" id="mkDex" role="group" aria-label="Filter by DEX">
        {DEXES.filter(([d]) => d === 'all' || dexesHere.has(d)).map(([d, l]) => <button key={d} className="chip" type="button" data-dex={d} aria-pressed={s.dex === d} onClick={() => mk.set({ dex: d })}>{l}</button>)}
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="ptable" id="mkTable">
          <thead id="mkHead"><tr><th>Pool</th><th>Price</th><th>{ivn} %</th><th>Liquidity<Tip term="liquidity" align="r" /></th><th>Volume {ivn}<Tip term="volume" align="r" /></th><th>Fees 24h</th><th>APR<Tip term="apr" align="r" /></th><th>Fee / step<Tip term="marketFeeStep" align="r" /></th><th>Age</th><th>Source<Tip term="marketSource" align="r" /></th></tr></thead>
          <tbody id="mkRows">
            {!M ? <tr><td className="empty">Markets need the app bundle.</td></tr>
              : s.loading && !s.rows.length ? <tr><td colSpan={10} className="empty" style={{ textAlign: 'center' }}>Reading Solana markets…</td></tr>
                : rows.length ? rows.map((r) => (
                  <tr key={r.address} data-mk={r.address} tabIndex={0} onClick={() => mk.set({ open: r.address })} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mk.set({ open: r.address }); } }}>
                    <td><span className="pp"><span style={{ display: 'grid', gap: 3 }}><b>{r.pair} <span className={'dexb ' + dexClass(r.dex)}>{r.dex}</span></b><small className="dim" style={{ fontSize: '11.5px' }}>{short(r.address)}{Date.now() - (r.at || 0) > STALE_MS && <> · <span className="warn">stale</span></>}</small></span></span></td>
                    <td>{r.priceUsd != null ? '$' + tiny(r.priceUsd) : r.priceNative != null ? <>{tiny(r.priceNative)} <span className="dim">{r.quote.symbol || ''}</span></> : <Dash />}</td>
                    <td>{chgIv(r)}</td><td><OrDash v={usd(r.liquidityUsd)} /></td>
                    <td>{volIv(r)}{r.txns24h ? <span className="sub">{r.txns24h.toLocaleString('en-US')} txns 24h</span> : null}</td>
                    <td><OrDash v={usd(r.feesUsd24h)} /></td><td><OrDash v={pctOrNull(r.aprPct)} /></td><td>{tier(r)}</td><td><OrDash v={ageLong(r.ageSec)} /></td>
                    <td><span className="src-age">{srcAge(r)}</span></td>
                  </tr>
                )) : <tr><td colSpan={10} className="empty" style={{ textAlign: 'center' }}>{none ? 'Live market data can\'t load on this page right now. Try again in a minute, or open Veyl on its own site.' : 'No pools match.'}</td></tr>}
          </tbody>
        </table>
        <div className="pcards" id="mkCards">
          {s.loading && !s.rows.length ? <div className="empty">Reading Solana markets…</div>
            : rows.length ? rows.slice(0, CARDS_MAX).map((r) => (
              <button key={r.address} className="pcard" type="button" data-mk={r.address} onClick={() => mk.set({ open: r.address })}>
                <span className="t"><span className="mid"><b style={{ fontWeight: 500 }}>{r.pair}</b><br /><small className="dim" style={{ fontSize: 12 }}>{chgIv(r)} · {srcAge(r)}</small></span><span className={'dexb ' + dexClass(r.dex)}>{r.dex}</span></span>
                <dl><div><dt>Liquidity</dt><dd><OrDash v={usd(r.liquidityUsd)} /></dd></div><div><dt>Volume {ivn}</dt><dd>{volIv(r)}</dd></div><div><dt>APR</dt><dd><OrDash v={pctOrNull(r.aprPct)} /></dd></div></dl>
              </button>
            )) : <div className="empty">{s.rows.length ? 'No pools match.' : 'No market data right now.'}</div>}
        </div>
      </div>
      <p className="quiet" id="mkCount">{!none && <><i></i>{rows.length} pools · external DEXes, read live in your browser{s.at ? ` · refreshed ${age(Date.now() - s.at)} ago` : ''}</>}</p>
      <Mirrors />
      <Drawer row={s.rows.find((r) => r.address === s.open) || null} />
    </section>
  );
}

// ---------------------------------------------------------------- detail drawer
function Drawer({ row: r }: { row: MarketRow | null }) {
  const [shown, setShown] = useState(false);
  const rt = useSession((x) => x.rt);
  const addr = r?.address;
  useEffect(() => {
    if (!addr) { setShown(false); return; }
    requestAnimationFrame(() => setShown(true));
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('keydown', esc); };
  }, [addr]);
  const close = () => { setShown(false); setTimeout(() => mk.set({ open: null }), 260); };
  const row = (k: string, v: ReactNode) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>;
  const addrRow = (label: string, a?: string) => a ? <div className="addr"><span><span className="dim" style={{ fontSize: 12 }}>{label}</span><br /><code>{a}</code></span><button type="button" data-copy={a} onClick={() => copyText(a, 'Address copied')}>Copy</button></div> : null;
  return (
    <>
      <div className={'side-bg' + (shown ? ' open' : '')} id="mkBg" onClick={close}></div>
      <aside className={'mdr' + (shown ? ' open' : '')} id="mkDrawer" aria-label="Pool details" hidden={!r}>
        {r && <>
          <div className="top">
            <div><h2>{r.pair} <span className={'dexb ' + dexClass(r.dex)}>{r.dex}</span></h2><p className="dim" style={{ margin: '4px 0 0', fontSize: 13 }}>External pool · {srcAge(r)} · not a Veyl pool</p></div>
            <button className="ib" type="button" id="mkX" aria-label="Close" onClick={close}><Icon name="x" size="sm" /></button>
          </div>
          <MarketChart address={r.address} />
          <dl className="det">
            {row('Price', r.priceUsd != null ? '$' + tiny(r.priceUsd) : r.priceNative != null ? `${tiny(r.priceNative)} ${r.quote.symbol || ''}` : <Dash />)}
            {row('24h change', r.change.h24 != null ? <Change c={r.change.h24} /> : <Dash />)}
            {row('Liquidity', <OrDash v={usd(r.liquidityUsd)} />)}{row('Volume 24h', <OrDash v={usd(r.volume.h24)} />)}{row('Fees 24h', <OrDash v={usd(r.feesUsd24h)} />)}{row('APR', <OrDash v={pctOrNull(r.aprPct)} />)}
            {r.binStep != null && row('Bin step', (r.binStep / 100).toFixed(2) + '%')}{r.feePct != null && row('Fee', r.feePct.toFixed(3) + '%')}{r.tickSpacing != null && row('Tick spacing', String(r.tickSpacing))}
            {row('Age', <OrDash v={ageLong(r.ageSec)} />)}{r.txns24h ? row('Transactions 24h', r.txns24h.toLocaleString('en-US')) : null}
          </dl>
          {addrRow('Pool', r.address)}{addrRow((r.base.symbol || 'Base') + ' mint', r.base.address)}{addrRow((r.quote.symbol || 'Quote') + ' mint', r.quote.address)}
          <div className="links">
            <a href={r.url} target="_blank" rel="noopener">Open on {r.dex.split(' ')[0]}</a><a href={r.explorer} target="_blank" rel="noopener">Solscan</a>
            <a href={'https://dexscreener.com/solana/' + r.address} target="_blank" rel="noopener">DexScreener</a><a href={'https://www.geckoterminal.com/solana/pools/' + r.address} target="_blank" rel="noopener">GeckoTerminal</a>
          </div>
          <MirrorRequest r={r} />
        </>}
      </aside>
    </>
  );
}

const TF = [{ value: 'minute:15', label: '15m', name: '15-minute' }, { value: 'hour:1', label: '1H', name: 'hourly' }, { value: 'hour:4', label: '4H', name: '4-hour' }, { value: 'day:1', label: '1D', name: 'daily' }];
/// An external pool's candles from GeckoTerminal (read in the browser like the rest of this page), at a timeframe.
function MarketChart({ address }: { address: string }) {
  const [tf, setTf] = useState('hour:1');
  const api = useSession((x) => x.rt?.markets?.api);
  const [frame, agg] = tf.split(':');
  const q = useChainQuery(['marketCandles', address, tf], api ? async () => { const d = await api.detail(address, frame, Number(agg)); return { c: d.candles || [], err: d.candlesError || null }; } : null,
    { initial: { c: [] as Candle[], err: null as string | null }, staleMs: 60_000, keepPrevious: false });
  const c = q.data.c; const name = TF.find((x) => x.value === tf)!.name;
  const note = q.loading ? 'Loading candles (GeckoTerminal)…' : !c.length ? (q.data.err ? `Candles unavailable (${q.data.err})` : 'No candles for this pool.') : `${c.length} ${name} candles · GeckoTerminal`;
  const candles = useMemo(() => c.map((x) => ({ t: x.t, o: x.o ?? x.c, h: x.h ?? x.c, l: x.l ?? x.c, c: x.c, v: (x as { v?: number }).v ?? null })).sort((a, b) => a.t - b.t), [c]);
  return (
    <div className="card chartcard" id="mkChartCard">
      <div className="h"><b>Price</b><Segmented className="seg sm" label="Candle size" value={tf} onChange={setTf} options={TF} /></div>
      <span className="dim" id="mkChartNote" style={{ fontSize: '12.5px' }}>{note}</span>
      {candles.length > 1 && <LibCandleChart candles={candles} height={220} label="Price candles" formatVolume={(v) => usd(v) ?? '—'} />}
    </div>
  );
}

// ---------------------------------------------------------------- mirror requests (kept in this browser, for the owner)
interface Mirror { address: string; pair: string; dex: string; binStep: number; at: number }
const MIRRORS_KEY = 'veyl:mirrors';
const mirrors = createStore<{ list: Mirror[] }>({ list: [] });
const saveMirrors = (list: Mirror[]) => { mirrors.set({ list }); storage.set(MIRRORS_KEY, list); };

function MirrorRequest({ r }: { r: MarketRow }) {
  const { list } = useStore(mirrors, (x) => x);
  const done = list.some((x) => x.address === r.address);
  const request = () => {
    if (done) { toast('Already requested.', 'clock'); return; }
    saveMirrors([{ address: r.address, pair: r.pair, dex: r.dex, binStep: r.binStep ?? (r.tickSpacing != null ? Math.max(1, r.tickSpacing) : 10), at: Date.now() }, ...list]);
    toast('Mirror request queued for the owner.');
  };
  return (
    <div className="mirror"><b>Mirror on Veyl<Tip term="mirror" align="l" /></b>
      <span>Queue a request for a Veyl pool of {r.pair}{r.binStep != null ? ` with bin step ${(r.binStep / 100).toFixed(2)}%` : ''}. Pool creation is gated to the factory authority; this only records the request for the owner, nothing is created.</span>
      <button className="btn" type="button" id="mkMirror" disabled={done} onClick={request}>{done ? 'Requested' : 'Request a mirror pool'}</button>
    </div>
  );
}

function Mirrors() {
  const { list } = useStore(mirrors, (x) => x);
  useEffect(() => { mirrors.set({ list: storage.get<Mirror[]>(MIRRORS_KEY, []) }); }, []);
  return (
    <>
      <div className="sec" id="mirrorH" hidden={!list.length}><h2>Mirror requests</h2></div>
      <div className="list" id="mirrorList">
        {list.map((x) => (
          <div key={x.address} className="row">
            <div className="mid"><b>{x.pair} <span className="pill flat">bin step {(x.binStep / 100).toFixed(2)}%</span></b><small>Mirrors {x.dex} {short(x.address)} · requested {age(Date.now() - x.at)} ago · waiting for the factory authority (nothing is created from here)</small></div>
            <div className="rt"><button className="btn sm ghost" type="button" onClick={() => saveMirrors(list.filter((m) => m.address !== x.address))}>Remove</button></div>
          </div>
        ))}
      </div>
    </>
  );
}
