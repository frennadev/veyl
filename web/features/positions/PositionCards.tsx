'use client';
// A position's card (range bar, value, fees, rewards, distance to its edges, worth, fee APR, its actions), a limit order's
// row, and the portfolio's totals. Shared by the portfolio and the pool page.
import { tl } from '@/features/pools/label';
import type { ReactNode } from 'react';
import { Icon, PairLogo, Skeleton, Tip } from '@/components/ui/primitives';
import { engine, usdOf } from '@/features/session/session';
import { tiny } from '@/lib/format';
import { SHAPE_LABEL } from '@/lib/veyl/services/liquidity';
import type { HoldingKind, OrderRecord, PoolState, PositionInfo, PositionRecord } from '@/lib/veyl/types';
import { failed, type PositionsData, type Read } from './positions';
import { openClaim, openOrderWithdraw, openRebalance, openReward, openWithdrawPosition } from './PositionDialogs';

const amt = (sym: string, v: bigint) => tiny(engine().fmt(sym, v));
const price = (st: PoolState | undefined, id: number) => (st ? engine().humanPrice(st, id) : null);
const usd2 = (v: number) => '$' + (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : Math.abs(v) >= 1 ? v.toFixed(2) : tiny(v));
const shapeName = (s: string) => SHAPE_LABEL[(s === 'bidAsk' ? 'bidask' : s) as keyof typeof SHAPE_LABEL] || s;

export function HoldingPill({ kind }: { kind: HoldingKind }) {
  return kind === 'shielded' ? <span className="pill priv"><Icon name="lock" />Private</span>
    : kind === 'private' ? <span className="pill priv"><Icon name="lock" />One-time key</span>
      : <span className="pill pubk">Public</span>;
}

/// Dollar worth and unclaimed fees of a position, when both tokens have a price.
export function positionUsd(q: PositionRecord, i: Read<PositionInfo> | undefined) {
  const ux = usdOf(q.x), uy = usdOf(q.y); if (ux == null || uy == null || !i || failed(i)) return null;
  const E = engine();
  return { v: E.fmt(q.x, i.value.x) * ux + E.fmt(q.y, i.value.y) * uy, f: E.fmt(q.x, i.fees.x) * ux + E.fmt(q.y, i.fees.y) * uy };
}

export function PositionCard({ q, d }: { q: PositionRecord; d: PositionsData }) {
  const i = d.info[q.id], st = d.pools[q.pool];
  const lo = price(st, q.lo), hi = price(st, q.hi);
  const head = (status?: ReactNode) => (
    <div className="t"><PairLogo x={q.x} y={q.y} />
      <div className="mid"><b>{tl(q.x)}–{tl(q.y)}</b><small>{lo != null && hi != null ? `${tiny(lo)} – ${tiny(hi)} ${q.y}` : `bins ${q.lo} … ${q.hi}`} · {q.hi - q.lo + 1} bins · {shapeName(q.shape)}</small></div>
      <HoldingPill kind={q.kind} /><Tip term="holding" align="r" />{status}
    </div>
  );
  if (!i) return <div className="pos" data-posrow={q.id}>{head()}<Skeleton width="60%" /></div>;
  if (failed(i)) return <div className="pos">{head()}<p className="err">Could not read this position: {i.err}</p></div>;
  const status = <>{i.open ? (i.inRange ? <span className="pill good">In range</span> : <span className="pill warn">Out of range</span>) : <span className="pill flat">Closed</span>}<Tip term="inRange" align="r" /></>;
  const w = Math.max(q.hi - q.lo + 20, 40), mid = (q.lo + q.hi) / 2, L = ((q.lo - (mid - w / 2)) / w) * 100, R = ((q.hi + 1 - (mid - w / 2)) / w) * 100, A = ((i.active + 0.5 - (mid - w / 2)) / w) * 100;
  const rewards = i.rewards.map((v, k) => ({ v, k })).filter((r) => r.v > 0n);
  const rewardSym = (k: number) => st?.rewards.find((r) => r.index === k)?.sym || 'reward';
  const fees = i.fees.x > 0n || i.fees.y > 0n;
  return (
    <div className="pos" data-posrow={q.id}>
      {head(status)}
      <div className="rangebar" aria-hidden="true"><i style={{ left: Math.max(0, L).toFixed(1) + '%', right: Math.max(0, 100 - R).toFixed(1) + '%' }}></i><em style={{ left: `calc(${Math.max(0, Math.min(100, A)).toFixed(1)}% - 1px)` }}></em></div>
      <div className="b">
        <div><span>Value</span><b className="sens">{amt(q.x, i.value.x)} {q.x}<br />{amt(q.y, i.value.y)} {q.y}</b></div>
        <div><span>Unclaimed fees<Tip term="unclaimedFees" /></span><b className="sens up">{fees ? <>{amt(q.x, i.fees.x)} {q.x}<br />{amt(q.y, i.fees.y)} {q.y}</> : 'None yet'}</b></div>
        <div><span>Rewards</span><b className="sens">{q.kind === 'shielded' ? <span className="dim">Not earned while shielded</span>
          : rewards.length ? rewards.map((r, n) => <span key={r.k}>{n > 0 && <br />}{tiny(engine().fmt(rewardSym(r.k), r.v))} {rewardSym(r.k)}</span>) : 'None'}</b></div>
      </div>
      <PositionPro q={q} i={i} st={st} />
      <div className="a">
        <button className="btn sm ghost" type="button" data-pa="claim" data-id={q.id} disabled={!fees} onClick={() => openClaim(q, i)}>Claim fees</button>
        {rewards.length > 0 && <button className="btn sm ghost" type="button" data-pa="reward" data-id={q.id} onClick={() => openReward(q, i, st)}>Claim rewards</button>}
        {i.open && <>
          <button className="btn sm ghost" type="button" data-pa="rebalance" data-id={q.id} onClick={() => openRebalance(q, i, st)}>Rebalance</button>
          <button className="btn sm" type="button" data-pa="withdraw" data-id={q.id} onClick={() => openWithdrawPosition(q, i)}>Withdraw</button>
        </>}
      </div>
    </div>
  );
}

const HOUR = 3600e3;
function PositionPro({ q, i, st }: { q: PositionRecord; i: PositionInfo; st: PoolState | undefined }) {
  const u = positionUsd(q, i); if (!u) return null;
  const ageMs = q.createdAt ? Date.now() - q.createdAt : null;
  const apr = ageMs && ageMs > HOUR && u.v > 0 ? (u.f / u.v) * ((365 * 864e5) / ageMs) * 100 : null;
  const P = price(st, i.active), Lp = price(st, q.lo), Hp = price(st, q.hi);
  return (
    <div className="ppro">
      {P != null && Lp != null && Hp != null && i.open && <div><span>To range edges<Tip term="toEdges" align="l" /></span><b>{i.inRange ? `−${Math.max(0, (P / Lp - 1) * 100).toFixed(1)}% · +${Math.max(0, (Hp / P - 1) * 100).toFixed(1)}%` : 'out of range'}</b></div>}
      <div><span>Worth</span><b className="sens">{usd2(u.v)}</b></div>
      <div><span>Fee APR since open<Tip term="feeApr" align="r" /></span><b className="sens">{apr != null ? apr.toFixed(apr < 10 ? 1 : 0) + '%' : ageMs ? 'after the first hour' : '—'}</b></div>
    </div>
  );
}

export function OrderRow({ o, d }: { o: OrderRecord; d: PositionsData }) {
  const i = d.orderInfo[o.id], st = d.pools[o.pool], at = price(st, o.binId);
  const ok = i && !failed(i) ? i : null;
  const status = o.closed ? <span className="pill flat">Withdrawn</span> : !i ? <Skeleton width={50} /> : failed(i) ? <span className="pill warn">Unreadable</span>
    : ok?.filled ? <span className="pill good">Filled</span> : ok && (o.isAsk ? ok.filledY > 0n : ok.filledX > 0n) ? <span className="pill warn">Part filled</span> : <span className="pill flat">Open</span>;
  const left = ok ? (o.isAsk ? `${amt(o.x, ok.unfilledX)} ${o.x} left · ${amt(o.y, ok.filledY)} ${o.y} received` : `${amt(o.y, ok.unfilledY)} ${o.y} left · ${amt(o.x, ok.filledX)} ${o.x} received`)
    : `${amt(o.sym, BigInt(o.amount))} ${o.sym}`;
  return (
    <div className="row">
      <div className="mid"><b>{o.isAsk ? 'Sell ' : 'Buy '}{o.x} · {tl(o.x)}–{tl(o.y)} <HoldingPill kind={o.kind} /></b><small>at {at != null ? `${tiny(at)} ${o.y}` : `bin ${o.binId}`} · <span className="sens">{left}</span></small></div>
      <div className="rt">{status}{!o.closed && <div style={{ marginTop: 6 }}><button className="btn sm ghost" type="button" data-ow={o.id} onClick={() => openOrderWithdraw(o, ok)}>Withdraw</button></div>}</div>
    </div>
  );
}

/// Totals across the visible positions: liquidity and unclaimed fees in dollars, how many are in range.
export function PortfolioSummary({ list, d }: { list: PositionRecord[]; d: PositionsData }) {
  if (!list.length) return <div className="pfsum" id="pfSum" hidden></div>;
  let v = 0, f = 0, inRange = 0, open = 0, priced = true;
  for (const q of list) {
    const i = d.info[q.id]; if (!i || failed(i)) continue;
    if (i.open) { open++; if (i.inRange) inRange++; }
    const u = positionUsd(q, i); if (u) { v += u.v; f += u.f; } else priced = false;
  }
  return (
    <div className="pfsum" id="pfSum">
      <div><span>Liquidity</span><b className="sens">{priced || v > 0 ? usd2(v) : '—'}</b></div>
      <div><span>Unclaimed fees</span><b className="sens up">{priced || f > 0 ? usd2(f) : '—'}</b></div>
      <div><span>In range</span><b>{inRange} / {open}</b></div>
    </div>
  );
}
