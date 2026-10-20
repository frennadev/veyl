'use client';
// One pool: its price and figures, the price chart, liquidity by bin (with what the panel is about to add), its parameters,
// your positions and orders in it, and the action panel.
import { tl } from '@/features/pools/label';
import { useEffect, type ReactNode } from 'react';
import { isModalOpen } from '@/components/overlay';
import { Icon, PairLogo, Skeleton, Dash, Tip } from '@/components/ui/primitives';
import type { Term } from '@/lib/glossary';
import { FaucetButton } from '@/features/session/AccountDialogs';
import { engine, usdOf, useSession } from '@/features/session/session';
import { go, useRoute } from '@/features/shell/router';
import { Change } from '@/features/pools/columns';
import { setInterval_, usePoolsUi } from '@/features/pools/state';
import { pct, pctOrNull, short, tiny, usd } from '@/lib/format';
import { INTERVALS, INTERVAL_LABEL, type PoolView } from '@/lib/veyl/services/pools';
import { binIds, distribution } from '@/lib/veyl/services/liquidity';
import { BinChart } from './charts';
import { PriceChart } from './PriceChart';
import { Panel } from './panel/Panel';
import { poolMath, type PoolMath } from './poolMath';
import { enterPool, openSheet, setPanel, usePanel } from './state';
import { usePoolData } from './usePoolData';
import { PoolBadge } from '@/features/pools/PoolBadge';
import { BondCard, StatusNotice } from './PoolStatus';
import { usePoolConfigs } from '@/features/pools/usePoolViews';
import { SealRow, activeSealed, useSealedPool, type SealedRead } from '@/features/sealed/sealed';
import { OrderRow, PositionCard } from '@/features/positions/PositionCards';
import { openOrders, usePositions, visiblePositions } from '@/features/positions/positions';

export default function PoolPage() {
  const id = useRoute().pool!;
  useEffect(() => enterPool(id), [id]);
  useEffect(() => { // Escape closes the phone sheet (an open dialog takes Escape first)
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape' && !isModalOpen()) setPanel({ sheet: false }); };
    document.addEventListener('keydown', f); return () => document.removeEventListener('keydown', f);
  }, []);
  const { pool, live } = usePoolData(id);
  const rt = useSession((s) => s.rt);
  const { iv } = usePoolsUi();
  const s = usePanel();
  const posData = usePositions();
  const sealed = useSealedPool(usePoolConfigs().find((c) => c.id === id) || null);
  if (!pool) return null;
  const m = live && pool.st && rt?.engine ? poolMath(rt.engine, pool.st) : null;
  const usdY = live ? usdOf(pool.y) : null;

  // what the chart overlays: the range and shape being added, a limit order's bin, this account's open orders here
  const a = m?.st.active ?? 0, lo = a + s.lo, hi = a + s.hi;
  const adding = s.tab === 'add' || s.tab === 'zap';
  const preview = adding && m && rt?.sdk
    ? distribution(rt.sdk, binIds(lo, hi), a, s.shape, s.side, m.price(a), s.tab === 'add' && s.side !== 'y' ? parseFloat(s.amtX) || 0 : 0, s.tab === 'add' && s.side !== 'x' ? parseFloat(s.amtY) || 0 : 0)
    : null;
  const orderBin = s.tab === 'limit' && m && parseFloat(s.ordPrice) > 0 ? m.binFor(parseFloat(s.ordPrice)) : null;
  const orders = live ? openOrders(posData.d, pool.address || undefined).map((o) => o.binId) : [];
  const message = !live ? 'Not connected to Solana.' : pool.err ? 'Could not read this pool: ' + pool.err.slice(0, 60) : 'Reading bins from the chain…';
  const chain = rt?.mode === 'chain';

  return (
    <section className="page" id="pg-pool">
      <div className="ptop">
        <button className="ib" id="backBtn" type="button" aria-label="Back to pools" onClick={() => go('pools')}><Icon name="back" /></button>
        <PairLogo x={pool.x} y={pool.y} />
        <h1 id="pName">{tl(pool.x)}–{tl(pool.y)}</h1>
        <span className="tags" id="pTags"><span className="pill priv"><Icon name="lock" />Private</span> <PoolBadge status={pool.status} /><FaucetTag pool={pool} /></span>
      </div>
      <div className="pgrid">
        <div className="pmain">
          <StatusNotice pool={pool} />
          <div className="phead">
            <PriceHead pool={pool} m={m} live={live} />
            <div className="iv sm" id="pIv" role="group" aria-label="Chart and stats interval" hidden={!chain}>
              {INTERVALS.map((v) => <button key={v} type="button" data-iv={v} aria-pressed={v === iv} onClick={() => setInterval_(v)}>{INTERVAL_LABEL[v]}</button>)}
            </div>
          </div>
          <PoolStats pool={pool} m={m} live={live} usdY={usdY} />
          {chain && <PriceChart pool={pool} />}
          <div className="card chartcard">
            <div className="h"><b>Liquidity by bin<Tip term="liquidityByBin" align="l" /></b><div className="legend" id="pLegend">
              <span><i style={{ background: 'var(--y-side)' }}></i>{tl(pool.y)} side</span><span><i style={{ background: 'var(--x-side)' }}></i>{tl(pool.x)} side</span>
              <span><i style={{ background: 'var(--act)' }}></i>Active bin</span><span><i className="ln" style={{ background: 'var(--wine-2)' }}></i>Your range</span>
            </div></div>
            <BinChart m={m} message={message} overlay={{ range: { lo, hi }, preview, orderBin, orders }} />
          </div>
          <MySealed pool={pool} read={sealed} />
          <PoolPositions pool={pool} live={live} />
          <BondCard pool={pool} />
          {chain && <PoolParams pool={pool} />}
        </div>
        <Panel pool={pool} m={m} usdY={usdY} ivSecs={iv} sealed={sealed} />
      </div>
      <div className="addbar"><div className="in">
        {(['add', 'zap', 'limit', 'swap'] as const).map((t, i) => <button key={t} className={'btn' + (i ? ' ghost' : '')} type="button" data-sheet={t} onClick={() => openSheet(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </div></div>
      <div className={'sheet-bg' + (s.sheet ? ' shown' : '')} id="sheetBg" onClick={() => setPanel({ sheet: false })}></div>
    </section>
  );
}

function FaucetTag({ pool }: { pool: PoolView }) {
  const faucet = useSession((s) => s.faucet);
  return faucet ? <>{' '}<FaucetButton className="pill flat drip" tokens={[pool.x, pool.y]} label={`Get test ${tl(pool.x)} + ${tl(pool.y)}`} /></> : null;
}

function PriceHead({ pool, m, live }: { pool: PoolView; m: PoolMath | null; live: boolean }) {
  const rt = useSession((s) => s.rt);
  const { iv } = usePoolsUi();
  const unit = `${tl(pool.y)} per ${tl(pool.x)}`;
  if (!rt?.engine) return <div className="px" id="pPx"><small style={{ marginTop: 0 }}>{unit} · bin step {(pool.bs / 100).toFixed(2)}%</small></div>;
  if (!m) return <div className="px" id="pPx"><b>{live && !pool.err ? '…' : '—'}</b><small>{unit}</small></div>;
  // the market's price for the pair: a reference beside the pool's own price, never in its place
  const mk = rt.engine.market, ux = mk.usd(pool.x), uy = mk.usd(pool.y);
  const ref = ux && uy ? ` · market ${tiny(ux / uy)} (${mk.label(pool.x)})` : rt.mode === 'sandbox' ? ` · price as of ${rt.engine.marketInfo().asOf}` : '';
  return (
    <div className="px" id="pPx">
      <b>{tiny(m.price(m.st.active))}</b>
      {pool.stats && rt.mode !== 'sandbox' && <><Change c={pool.stats.change} /> <span className="dim" style={{ marginLeft: 4, fontSize: '12.5px' }}>{INTERVAL_LABEL[iv]}</span></>}
      <small>{unit}{ref}</small>
    </div>
  );
}

type Stat = [string, ReactNode, ReactNode];
function PoolStats({ pool: p, m, live, usdY }: { pool: PoolView; m: PoolMath | null; live: boolean; usdY: number | null }) {
  const protocolFeeBps = useSession((x) => x.rt?.protocolFeeBps ?? null);
  const mode = useSession((s) => s.rt?.mode);
  const { iv } = usePoolsUi(); const ivn = INTERVAL_LABEL[iv];
  const v = (x: () => ReactNode) => (m ? x() : live && !p.err ? <Skeleton width="70%" /> : <Dash />);
  const reserves = m ? `${m.amt(p.x, m.st.reserves.x)} ${tl(p.x)} + ${m.amt(p.y, m.st.reserves.y)} ${tl(p.y)}` : '';
  const ps = p.stats, bs = (p.bs / 100).toFixed(2) + '%';
  const rows: Stat[] = !mode || mode === 'preview'
    ? [['Bin step', bs, 'per bin'], ['Base fee', p.base.toFixed(2) + '%', 'rises with volatility'], ['Fee cap', '10%', 'never above']]
    : mode === 'sandbox'
      ? [['Liquidity', v(() => (usdY != null ? usd(m!.liquidityInY() * usdY) : `${tiny(m!.liquidityInY())} ${tl(p.y)}`)), reserves], ['Trading fee now', v(() => pct(m!.st.fee)), `base ${p.base.toFixed(2)}%`], ['Bin step', bs, 'per bin']]
      : [
        ['Liquidity', ps ? usd(ps.tvlUsd) ?? <Dash /> : v(() => tiny(m!.liquidityInY())), reserves],
        ['Volume ' + ivn, ps ? usd(ps.volumeUsd) ?? <Dash /> : <Dash />, ps ? `${ps.swaps} swaps` : 'not recorded on chain'],
        ['Fees ' + ivn, ps ? usd(ps.feesUsd) ?? <Dash /> : <Dash />, ps ? `APR ${pctOrNull(ps.aprPct) ?? '—'} to LPs` : 'not recorded on chain'],
        ['Bin step', bs, 'per bin'],
        ['Dynamic fee', v(() => pct(m!.st.fee)), `base ${p.base.toFixed(2)}% + volatility${protocolFeeBps != null ? ` · swaps also pay ${(protocolFeeBps / 100).toFixed(2)}% protocol` : ''}`],
        ['Fees, all time', v(() => tiny(engine().fmt(p.x, m!.st.totalFees.x) * m!.price(m!.st.active) + engine().fmt(p.y, m!.st.totalFees.y))), m ? `in ${tl(p.y)} at today's price` : ''],
      ];
  const termOf = (k: string): Term | null => (/^Liquidity/.test(k) ? 'liquidity' : /^Bin step/.test(k) ? 'binStep' : /^(Trading fee now|Fee now|Dynamic fee)/.test(k) ? (protocolFeeBps != null ? 'traderCost' : 'dynamicFee') : /^Base fee/.test(k) ? 'baseFee' : /^Volume/.test(k) ? 'volume' : null);
  return <div className={'stats' + (rows.length === 3 ? ' three' : '')} id="pStats">{rows.map(([k, val, sub]) => { const t = termOf(k); return <div key={k} className="stat"><span>{k}{t && <Tip term={t} align="l" />}</span><b>{val}</b><small>{sub}</small></div>; })}</div>;
}

function PoolParams({ pool: p }: { pool: PoolView }) {
  const st = p.st;
  const protocolFeeBps = useSession((x) => x.rt?.protocolFeeBps ?? null);
  const rows: [string, ReactNode][] = [
    ['Bin step', (p.bs / 100).toFixed(2) + '% per bin'], ['Base fee', p.base.toFixed(2) + '%'], ['Dynamic fee now', st ? pct(st.fee) : <Dash />], ['Fee cap', '10%'],
    protocolFeeBps != null ? ['Protocol fee', `${(protocolFeeBps / 100).toFixed(2)}% of each swap, on top of the LP fee`]
      : ['Protocol share of fees', st?.protocolShare != null ? (st.protocolShare / 100).toFixed(0) + '%' : <Dash />], ['Active bin', st ? String(st.active) : <Dash />],
    ['Farm rewards', st ? (st.rewards.length ? st.rewards.map((r) => (r.sym || short(r.mint)) + (r.live ? ' · emitting' : ' · ended')).join(', ') : 'None') : <Dash />],
    ['Pool address', p.address ? <span className="mono">{short(p.address)}</span> : <Dash />],
  ];
  return (
    <div className="card pad" id="pParamsCard">
      <div className="sec" style={{ margin: '0 0 8px' }}><h2>Pool parameters</h2></div>
      <dl className="params" id="pParams">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </div>
  );
}

function PoolPositions({ pool, live }: { pool: PoolView; live: boolean }) {
  const { d } = usePositions();
  const account = useSession((s) => s.account);
  const list = live && pool.address ? visiblePositions(d, pool.address) : [];
  const orders = live && pool.address ? openOrders(d, pool.address) : [];
  return (
    <>
      <div className="sec"><h2>Your positions in this pool</h2></div>
      <div className="list" id="pPos">
        {list.length ? list.map((q) => <PositionCard key={q.id} q={q} d={d} />)
          : <div className="card empty">{!live ? 'No positions yet.' : account ? 'No positions in this pool yet.' : 'Connect a wallet to see your positions.'}</div>}
      </div>
      <div className="sec" id="pOrdH" hidden={!orders.length}><h2>Your limit orders here</h2></div>
      <div className="list" id="pOrd">{orders.map((o) => <OrderRow key={o.id} o={o} d={d} />)}</div>
    </>
  );
}

function MySealed({ pool, read }: { pool: PoolView; read: SealedRead }) {
  const mine = pool.address ? activeSealed(read.mine, pool.address) : [];
  return (
    <>
      <div className="sec" id="pSealH" hidden={!mine.length}><h2>Your sealed swaps</h2></div>
      <div className="list" id="pSeal">{mine.map((x) => <SealRow key={x.id} x={x} />)}</div>
    </>
  );
}
