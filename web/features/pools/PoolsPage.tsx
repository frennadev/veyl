'use client';
// The pools list: search, category and token chips, sort, interval, columns and filters; a table on wide screens and cards
// on phones. Rows open the pool page. Figures come only from the chain (or the Sandbox); preview shows the listed pools.
import { tl } from './label';
import { useEffect, useMemo } from 'react';
import { Icon, OrDash, PairLogo, TokenLogo, Tip } from '@/components/ui/primitives';
import { Popover } from '@/components/ui/Popover';
import { usdOf, useSession } from '@/features/session/session';
import { openPool } from '@/features/shell/router';
import { pct, pctOrNull, tiny, usd } from '@/lib/format';
import {
  CATEGORIES, INTERVALS, INTERVAL_LABEL, SORTS, type PoolFilter, activeFilterCount, filterOptions, filterPools, liquidityInY, priceOf, sortPools, type PoolView,
} from '@/lib/veyl/services/pools';
import { COLUMNS, DEFAULT_COLUMNS, Change, Spark, liquidityCell, visibleColumns, type CellCtx } from './columns';
import { poolsUi, restorePoolsUi, setColumns, setFilter, setInterval_, setSort, usePoolsUi } from './state';
import { usePoolViews } from './usePoolViews';
import { PoolBadge } from './PoolBadge';
import { statusOf } from '@/lib/veyl/services/pools';
import type { PoolConfig } from '@/lib/veyl/types';

/// The fee tier when the pool has one (open pool creation), else its bin step as before.
const tierText = (p: PoolConfig) => (p.tier ? `${(p.tier.feePips / 1e4).toFixed(2)}% fee · bin ${(p.tier.binStep / 100).toFixed(2)}%` : `Bin ${(p.bs / 100).toFixed(2)}%`);

/// Verified / unverified and "show delisted", shown only once some pool isn't simply verified.
function StatusChips({ pools }: { pools: PoolView[] }) {
  const ui = usePoolsUi();
  const unverified = pools.filter((p) => statusOf(p) === 'unverified').length, delisted = pools.filter((p) => statusOf(p) === 'delisted').length;
  if (!unverified && !delisted) return null;
  const opts: [PoolFilter['status'], string][] = unverified ? [['all', 'All'], ['verified', 'Verified'], ['unverified', `Unverified (${unverified})`]] : [];
  return (
    <div className="chips" id="statusChips" role="group" aria-label="Filter by listing status">
      {opts.map(([v, l]) => <button key={v} className="chip" type="button" data-status={v} aria-pressed={ui.filter.status === v} onClick={() => setFilter({ status: v })}>{l}</button>)}
      {delisted > 0 && <button className="chip" type="button" data-delisted="" aria-pressed={ui.filter.delisted} onClick={() => setFilter({ delisted: !ui.filter.delisted })}>Delisted ({delisted})</button>}
      <Tip term="unverified" align="l" />
    </div>
  );
}

/// The legacy page hides the interval, sort, column and filter tools (renderPools sets #poolTools hidden); kept in step.
const SHOW_TOOLS = false;

export default function PoolsPage() {
  useEffect(restorePoolsUi, []);
  const ui = usePoolsUi();
  const rt = useSession((s) => s.rt);
  const { pools, live } = usePoolViews(ui.iv);
  const mode = rt?.mode || 'preview';
  const E = live ? rt!.engine : null;

  const ctx: CellCtx = useMemo(() => ({
    mode, ivLabel: INTERVAL_LABEL[ui.iv], E,
    usdOf: (s) => (E ? usdOf(s) : null),
  }), [mode, ui.iv, E, rt]);

  const options = useMemo(() => filterOptions(pools), [pools]);
  const shown = useMemo(() => {
    const liq = (p: PoolView) => { if (!E) return 0; const r = ctx.usdOf(p.y), v = liquidityInY(E, p); return r == null ? v : v * r; };
    return sortPools(filterPools(pools, ui.filter), ui.sort, liq);
  }, [pools, ui.filter, ui.sort, E, ctx]);
  const cols = visibleColumns(mode, ui.cols);
  const nFilters = activeFilterCount(ui.filter);

  return (
    <section className="page" id="pg-pools">
      <div className="ph"><div><h1>Pools</h1><p>Pick a pool, set your range, earn the fees. Nobody sees whose liquidity it is.</p></div></div>
      <div className="ptools">
        <label className="search"><Icon name="search" />
          <input id="poolQ" type="text" placeholder="Search by token or pair" aria-label="Search pools" autoComplete="off" value={ui.filter.q} onChange={(e) => setFilter({ q: e.target.value })} />
        </label>
        <div className="grp" id="poolTools" hidden={!SHOW_TOOLS}>
          <div className="iv" id="ivSeg" role="group" aria-label="Interval for volume, fees and APR">
            {INTERVALS.map((iv) => <button key={iv} type="button" data-iv={iv} aria-pressed={iv === ui.iv} onClick={() => setInterval_(iv)}>{INTERVAL_LABEL[iv]}</button>)}
          </div>
          <label className="sortl">{'Sort by '}
            <select className="sel" id="poolSort" aria-label="Sort pools" value={ui.sort} onChange={(e) => setSort(e.target.value as typeof ui.sort)}>
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <Popover id="col" button={<><Icon name="cols" size="sm" />Columns</>}>
            <span className="h">Columns</span>
            {COLUMNS.map((c) => (
              <label key={c.id}><input type="checkbox" checked={ui.cols.includes(c.id)}
                onChange={(e) => setColumns(COLUMNS.map((x) => x.id).filter((id) => (id === c.id ? e.target.checked : ui.cols.includes(id))))} />{c.name}</label>
            ))}
            <div className="foot"><button type="button" onClick={() => setColumns(DEFAULT_COLUMNS)}>Default columns</button></div>
          </Popover>
          <Popover id="flt" button={<><Icon name="filter" size="sm" />Filters<em id="fltN">{nFilters || ''}</em></>}>
            <span className="h">Base fee</span>
            <FilterChips values={options.bases.map(String)} current={ui.filter.base} fmt={(v) => (+v).toFixed(2) + '%'} onPick={(base) => setFilter({ base })} />
            <span className="h">Bin step</span>
            <FilterChips values={options.binSteps.map(String)} current={ui.filter.bs} fmt={(v) => (+v / 100).toFixed(2) + '%'} onPick={(bs) => setFilter({ bs })} />
            <div className="foot">
              <button type="button" onClick={() => poolsUi.set((s) => ({ filter: { ...s.filter, base: 'all', bs: 'all', tok: 'all', cat: 'all' } }))}>Clear filters</button>
              <span className="dim" style={{ fontSize: 12 }}>Tokens and categories: the chips below</span>
            </div>
          </Popover>
        </div>
      </div>
      <StatusChips pools={pools} />
      <div className="chips" id="tokChips" role="group" aria-label="Filter by token" hidden>
        {CATEGORIES.map((c) => <button key={c.id} className="chip" type="button" data-cat={c.id} aria-pressed={ui.filter.cat === c.id} onClick={() => setFilter({ cat: c.id })}>{c.label}</button>)}
        <span className="div" aria-hidden="true"></span>
        {['all', ...options.tokens].map((t) => (
          <button key={t} className="chip" type="button" data-tok={t} aria-pressed={ui.filter.tok === t} onClick={() => setFilter({ tok: t })}>
            {t === 'all' ? 'All tokens' : <><TokenLogo sym={t} size={18} />{t}</>}
          </button>
        ))}
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="ptable" id="poolTable">
          <thead id="poolHead">
            <tr><th>Pool</th>{cols.map((c) => (
              <th key={c.id} data-col={c.id} data-sort={c.sort} className={c.sort ? 'sortable' : undefined} aria-sort={c.sort && ui.sort === c.sort ? 'descending' : undefined}
                onClick={c.sort ? () => setSort(c.sort!) : undefined}>{c.label ? c.label(ctx) : c.name}{c.term && <Tip term={c.term} align="r" />}</th>
            ))}</tr>
          </thead>
          <tbody id="poolRows">
            {shown.length ? shown.map((p) => (
              <tr key={p.id} data-pool={p.id} tabIndex={0} onClick={() => openPool(p.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPool(p.id); } }}>
                <td><span className="pp"><PairLogo x={p.x} y={p.y} /><span><b>{tl(p.x)}–{tl(p.y)}</b><small><span className="pill priv catp"><Icon name="lock" />Private</span> <PoolBadge status={p.status} tip={false} /> <span className="dim" style={{ fontSize: '11.5px' }}>{tierText(p)}</span></small></span></span></td>
                {cols.map((c) => <td key={c.id} data-col={c.id}>{c.cell(p, ctx)}</td>)}
              </tr>
            )) : <tr><td colSpan={cols.length + 1} className="empty" style={{ textAlign: 'center' }}>No pools match.</td></tr>}
          </tbody>
        </table>
        <div className="pcards" id="poolCards">
          {shown.length ? shown.map((p) => <PoolCard key={p.id} p={p} ctx={ctx} />) : <div className="empty">No pools match.</div>}
        </div>
      </div>
      <p className="quiet" id="poolCount"><i></i>{shown.length} of {pools.length} pools · <SourceNote mode={mode} /></p>
    </section>
  );
}

function FilterChips({ values, current, fmt, onPick }: { values: string[]; current: string; fmt: (v: string) => string; onPick: (v: string) => void }) {
  return (
    <div className="chips">
      {['all', ...values].map((v) => <button key={v} className="chip" type="button" aria-pressed={current === v} onClick={() => onPick(v)}>{v === 'all' ? 'Any' : fmt(v)}</button>)}
    </div>
  );
}

function PoolCard({ p, ctx }: { p: PoolView; ctx: CellCtx }) {
  const s = p.stats, sbx = ctx.mode === 'sandbox', price = ctx.E && p.st ? priceOf(ctx.E, p) : null;
  return (
    <button className="pcard" type="button" data-pool={p.id} onClick={() => openPool(p.id)}>
      <span className="t"><PairLogo x={p.x} y={p.y} />
        <span className="mid"><b style={{ fontWeight: 500 }}>{tl(p.x)}–{tl(p.y)}</b><br /><small className="dim" style={{ fontSize: 12 }}>{tierText(p)}{s && !sbx && <> · <Change c={s.change} /></>}</small></span>
        {p.status && p.status !== 'verified' ? <PoolBadge status={p.status} tip={false} /> : s && !sbx ? <Spark vals={s.spark} /> : <span className="pill priv"><Icon name="lock" />Private</span>}
      </span>
      <dl>
        <div><dt>Price</dt><dd><OrDash v={price != null ? tiny(price) : null} /></dd></div>
        <div><dt>Liquidity</dt><dd>{liquidityCell(p, ctx, true)}</dd></div>
        {sbx ? <div><dt>Fee</dt><dd><OrDash v={p.st ? pct(p.st.fee) : null} /></dd></div> : <>
          <div><dt>Volume {ctx.ivLabel}</dt><dd><OrDash v={s ? usd(s.volumeUsd) : null} /></dd></div>
          <div><dt>APR {ctx.ivLabel}</dt><dd><OrDash v={s ? pctOrNull(s.aprPct) : null} /></dd></div>
        </>}
      </dl>
    </button>
  );
}

function SourceNote({ mode }: { mode: string }) {
  const rt = useSession((s) => s.rt);
  if (rt?.mode === 'sandbox') { const m = rt.engine.market; return <>{m.at ? `prices from the live market (${m.label('SOL')})` : `prices as of ${rt.engine.marketInfo().asOf}`}</>; }
  if (rt?.mode === 'chain') { const m = rt.engine.market; return <>read from {rt.chainName}: bins, vaults and each pool&apos;s Swapped events · dollar values at market prices{m.at ? ` (${m.label('SOL')})` : ' (market price unavailable)'}</>; }
  return <>{mode === 'preview' ? 'every pool is private' : ''}</>;
}
