'use client';
// Claim fees, claim rewards, rebalance, withdraw a position, withdraw an order. A shielded holding is spent with a proof
// (back into notes); a one-time-key holding is signed on this device and can pay out to the private balance or an address;
// a public one is signed by the wallet and pays to it.
import { tl } from '@/features/pools/label';
import { useEffect, useState, type ReactNode } from 'react';
import { Hint, ErrorLine, Segmented, Tip } from '@/components/ui/primitives';
import { openModal } from '@/components/overlay';
import { runAction, type ActionKind } from '@/features/actions/runAction';
import { engine } from '@/features/session/session';
import { short, tiny, SOLANA_ADDRESS } from '@/lib/format';
import { SHAPE_LABEL, engineShape, type Shape } from '@/lib/veyl/services/liquidity';
import type { HoldingKind, OrderInfo, OrderRecord, PoolState, PositionInfo, PositionRecord } from '@/lib/veyl/types';

const amt = (sym: string, v: bigint) => tiny(engine().fmt(sym, v));
const kindOf = (k: HoldingKind): ActionKind => (k === 'shielded' ? 'proof' : k === 'private' ? 'sign' : 'wallet');
const isPrivate = (k: HoldingKind) => k !== 'public';
const PublicHint = () => <Hint icon="alert" tone="warn">Paid to your wallet, in public.</Hint>;
/// A label / value list; a row's optional third item is its value's element id.
const Amounts = ({ rows }: { rows: [string, ReactNode, string?][] }) => <dl className="dl">{rows.map(([k, v, id]) => <div key={k}><dt>{k}</dt><dd id={id}>{v}</dd></div>)}</dl>;
/// Where a one-time-key payout goes, in words: the private balance (to = null) or an address.
const destWords = (to: string | null) => (to ? 'to ' + short(to) : 'to private balance');

// ---------------------------------------------------------------- where a one-time-key payout goes
function useDestination(id: string) {
  const [mode, setMode] = useState<'notes' | 'addr'>('notes'), [to, setTo] = useState('');
  const node = (
    <>
      <div className="lbl"><span>Send to<Tip term="sendTo" align="l" /></span></div>
      <Segmented id={id} dataKey="d" label="Send to" value={mode} onChange={setMode} options={[{ value: 'notes', label: 'Private balance' }, { value: 'addr', label: 'An address' }]} />
      <div className="fld" id={id + 'A'} hidden={mode !== 'addr'}>
        <input type="text" id={id + 'To'} placeholder="Fresh Solana address" autoComplete="off" spellCheck={false} aria-label="Recipient address" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
    </>
  );
  /// The chosen recipient (null = private balance), or an error to show.
  const resolve = (): { to: string | null } | { err: string } => {
    if (mode !== 'addr') return { to: null };
    const t = to.trim(); return SOLANA_ADDRESS.test(t) ? { to: t } : { err: 'Enter a full Solana address.' };
  };
  return { node, resolve };
}

// ---------------------------------------------------------------- claim fees
export const openClaim = (q: PositionRecord, i: PositionInfo) => openModal(<ClaimDialog q={q} i={i} />);
function ClaimDialog({ q, i }: { q: PositionRecord; i: PositionInfo }) {
  const dest = useDestination('cD'); const [err, setErr] = useState('');
  const go = () => {
    const d = q.kind === 'private' ? dest.resolve() : { to: null }; if ('err' in d) return setErr(d.err);
    runAction({
      title: 'Claiming fees', kind: kindOf(q.kind), exec: (E) => E.claimFees(q, { to: d.to }),
      done: (r) => ({
        title: 'Fees claimed', tx: r.tx,
        body: `${amt(q.x, r.x)} ${q.x} and ${amt(q.y, r.y)} ${q.y}` + (isPrivate(q.kind) ? (d.to ? ` sent to ${short(d.to)}.` : ' are in your private balance.') : ' are in your wallet.'),
        activity: { t: `Claimed fees · ${q.x}–${q.y}`, s: isPrivate(q.kind) ? (d.to ? 'To ' + short(d.to) : 'To private balance') : 'To wallet', amt: `${amt(q.x, r.x)} ${q.x} + ${amt(q.y, r.y)} ${q.y}` },
      }),
    });
  };
  return (
    <>
      <h3 id="dlgTitle">Claim fees · {tl(q.x)}–{tl(q.y)}<Tip term="claimFees" align="l" /></h3>
      <Amounts rows={[[q.x, amt(q.x, i.fees.x)], [q.y, amt(q.y, i.fees.y)]]} />
      {q.kind === 'shielded' ? <Hint icon="lock">A proof made on this device claims what your shares earned into new notes; nobody sees how much. The fee growth includes what the pool has collected so far; the rest arrives with the next harvest. The relayer&apos;s flat fee comes out of the claim.</Hint>
        : q.kind === 'private' ? <>{dest.node}<Hint icon="lock">The position key signs here; a relayer submits and takes its fee from the claim. Claims too small to cover the relayer&apos;s cost are refused, not charged.</Hint></>
          : <PublicHint />}
      <ErrorLine id="cErr">{err}</ErrorLine>
      <button className="btn" type="button" id="cGo" onClick={go}>Claim</button>
    </>
  );
}

// ---------------------------------------------------------------- claim rewards
export const openReward = (q: PositionRecord, i: PositionInfo, st?: PoolState) => openModal(<RewardDialog q={q} i={i} st={st} />);
function RewardDialog({ q, i, st }: { q: PositionRecord; i: PositionInfo; st?: PoolState }) {
  const list = i.rewards.map((v, k) => ({ v, k })).filter((r) => r.v > 0n);
  const sym = (k: number) => st?.rewards.find((r) => r.index === k)?.sym || 'reward';
  const first = list[0];
  const go = () => runAction({
    title: 'Claiming rewards', kind: kindOf(q.kind), exec: (E) => E.claimReward(q, first.k),
    done: (r) => ({
      title: 'Rewards claimed', tx: r.tx, body: `${tiny(engine().fmt(r.sym, r.amount))} ${r.sym}${isPrivate(q.kind) ? ' in your private balance.' : ' in your wallet.'}`,
      activity: { t: `Claimed rewards · ${q.x}–${q.y}`, s: isPrivate(q.kind) ? 'To private balance' : 'To wallet', amt: `${tiny(engine().fmt(r.sym || sym(first.k), r.amount))} ${r.sym || ''}` },
    }),
  });
  return (
    <>
      <h3 id="dlgTitle">Claim rewards · {tl(q.x)}–{tl(q.y)}</h3>
      <Amounts rows={list.map((r) => [`Slot ${r.k + 1}`, `${tiny(engine().fmt(sym(r.k), r.v))} ${sym(r.k)}`])} />
      <Hint icon={isPrivate(q.kind) ? 'lock' : 'alert'}>{isPrivate(q.kind) ? 'Into your private balance.' : 'Paid to your wallet, in public.'}</Hint>
      <button className="btn" type="button" id="rGo" onClick={go}>Claim {sym(first.k)}</button>
    </>
  );
}

// ---------------------------------------------------------------- rebalance
export const openRebalance = (q: PositionRecord, i: PositionInfo, st?: PoolState) => openModal(<RebalanceDialog q={q} i={i} st={st} />);
function RebalanceDialog({ q, i, st }: { q: PositionRecord; i: PositionInfo; st?: PoolState }) {
  const [limit, setLimit] = useState<number | null>(null), [err, setErr] = useState('');
  const [n, setN] = useState(q.hi - q.lo + 1);
  const [shape, setShape] = useState<Shape>(q.shape === 'bidAsk' ? 'bidask' : (q.shape as Shape));
  useEffect(() => { engine().rebalanceLimit(q).then(setLimit, (e) => setErr((e as Error).message)); }, [q]);
  const bins = limit !== null ? Math.max(1, Math.min(limit, n)) : n;
  const lo = i.active - Math.floor((bins - 1) / 2), hi = lo + bins - 1;
  const p = (id: number) => (st ? tiny(engine().humanPrice(st, id)) : String(id));
  const go = () => runAction({
    title: 'Rebalancing', kind: kindOf(q.kind), exec: (E) => E.rebalance(q, { lo, hi, shape: engineShape(shape) }),
    done: (r) => ({
      title: 'Rebalanced', tx: r.tx, body: `Your position now covers ${p(lo)} – ${p(hi)} ${q.y}.`,
      activity: { t: `Rebalanced · ${q.x}–${q.y}`, s: `${isPrivate(q.kind) ? 'Private' : 'Public'} · ${bins} bins around ${p(i.active)}`, amt: '' },
    }),
  });
  const how = q.kind === 'shielded'
    ? 'Inside the position\'s 16-bin window this is one proof: the old bins are burned and the new shape minted from the proceeds. Outside it, two: a removal into notes, then a new position from them.'
    : q.kind === 'private' ? 'Signed by the position key on this device. The relayer\'s fee is withheld from the burned amounts; anything the new shape cannot use returns as notes.'
      : 'Your wallet signs. Leftovers return to your wallet.';
  return (
    <>
      <h3 id="dlgTitle">Rebalance · {tl(q.x)}–{tl(q.y)}<Tip term="rebalance" align="l" /></h3>
      <p>Burns the position and re-adds it around the current price in one instruction. Fees already earned stay claimable.</p>
      <Amounts rows={[['Now', `${p(q.lo)} – ${p(q.hi)} · ${q.hi - q.lo + 1} bins`], ['New', `${p(lo)} – ${p(hi)}`, 'rbNew'], ['Bins', String(bins), 'rbN']]} />
      <Segmented id="rbShape" dataKey="s" className="shape" label="Shape" value={shape} onChange={setShape} options={(Object.keys(SHAPE_LABEL) as Shape[]).map((k) => ({ value: k, label: SHAPE_LABEL[k] }))} />
      <div className="presets" id="rbW">
        <button type="button" onClick={() => setN(Math.max(1, bins - 2))}>Narrower</button>
        <button type="button" onClick={() => setN(bins + 2)}>Wider</button>
      </div>
      <p className="quiet" id="rbLim"><i></i>{limit === null ? 'Checking how many bins fit one transaction…'
        : q.kind === 'shielded' ? `A shielded position covers up to ${limit} bins.` : `The old and new bins travel in one transaction: up to ${limit} new bin${limit === 1 ? '' : 's'} for this position.`}</p>
      <Hint icon={isPrivate(q.kind) ? 'lock' : 'alert'}>{how}</Hint>
      <ErrorLine id="rbErr">{err}</ErrorLine>
      <button className="btn" type="button" id="rbGo" disabled={!(limit && limit > 0)} onClick={go}>Rebalance</button>
    </>
  );
}

// ---------------------------------------------------------------- withdraw a position
const SHARES = ['25', '50', '100'] as const;
export const openWithdrawPosition = (q: PositionRecord, i: PositionInfo) => openModal(<WithdrawDialog q={q} i={i} />);
function WithdrawDialog({ q, i }: { q: PositionRecord; i: PositionInfo }) {
  const [pc, setPc] = useState<(typeof SHARES)[number]>('100'); const dest = useDestination('wD'); const [err, setErr] = useState('');
  const go = () => {
    const d = q.kind === 'private' ? dest.resolve() : { to: null }; if ('err' in d) return setErr(d.err);
    const share = +pc;
    runAction({
      title: 'Withdrawing', kind: kindOf(q.kind), exec: (E) => E.removeLiquidity(q, share, { to: d.to }),
      done: (r) => ({
        title: `Withdrew ${share}%`, tx: r.tx,
        body: isPrivate(q.kind) ? (d.to ? `Sent to ${short(d.to)}. On-chain it came from the pool.` : `Back in your private balance: ${amt(q.x, r.x)} ${q.x} and ${amt(q.y, r.y)} ${q.y}.`) : 'Back in your wallet.',
        activity: { t: `Withdrew liquidity · ${q.x}–${q.y}`, s: `${share}% · ${isPrivate(q.kind) ? destWords(d.to) : 'to wallet'}`, amt: '' },
      }),
    });
  };
  return (
    <>
      <h3 id="dlgTitle">Withdraw · {tl(q.x)}–{tl(q.y)}<Tip term="withdrawShare" align="l" /></h3>
      <Amounts rows={[[q.x, amt(q.x, i.value.x)], [q.y, amt(q.y, i.value.y)]]} />
      <Segmented id="wdPct" dataKey="p" label="Share to withdraw" value={pc} onChange={setPc} options={SHARES.map((v) => ({ value: v, label: v + '%' }))} />
      {q.kind === 'shielded' ? <Hint icon="lock">Back into your private balance. Public: the shares this removes per price bin and what they pay out, not your position&apos;s size or who you are. Fees earned so far come with it.</Hint>
        : q.kind === 'private' ? dest.node : <PublicHint />}
      {q.kind !== 'shielded' && <Hint icon="clock">Unclaimed fees and rewards stay with the position until you claim them.</Hint>}
      <ErrorLine id="wdErr">{err}</ErrorLine>
      <button className="btn" type="button" id="wdGo" onClick={go}>Withdraw</button>
    </>
  );
}

// ---------------------------------------------------------------- withdraw an order
export const openOrderWithdraw = (o: OrderRecord, i: OrderInfo | null) => openModal(<OrderWithdrawDialog o={o} i={i} />);
function OrderWithdrawDialog({ o, i }: { o: OrderRecord; i: OrderInfo | null }) {
  const dest = useDestination('oD'); const [err, setErr] = useState('');
  const rows: [string, ReactNode][] = [['Side', (o.isAsk ? 'Sell ' : 'Buy ') + o.x], ['Status', i ? (i.filled ? 'Filled' : 'Open') : '—']];
  if (i) rows.push(...(o.isAsk
    ? [['Unfilled', `${amt(o.x, i.unfilledX)} ${o.x}`], ['Received', `${amt(o.y, i.filledY)} ${o.y}`]] as [string, string][]
    : [['Unfilled', `${amt(o.y, i.unfilledY)} ${o.y}`], ['Received', `${amt(o.x, i.filledX)} ${o.x}`]] as [string, string][]));
  const go = () => {
    const d = o.kind === 'private' ? dest.resolve() : { to: null }; if ('err' in d) return setErr(d.err);
    runAction({
      title: 'Withdrawing the order', kind: kindOf(o.kind), exec: (E) => E.withdrawOrder(o, { to: d.to }),
      done: (r) => ({
        title: 'Order withdrawn', tx: r.tx,
        body: `${amt(o.x, r.x)} ${o.x} and ${amt(o.y, r.y)} ${o.y}` + (isPrivate(o.kind) ? (d.to ? ` sent to ${short(d.to)}.` : ' back in your private balance.') : ' back in your wallet.'),
        activity: { t: `Order withdrawn · ${o.x}–${o.y}`, s: (r.filled ? 'Filled · ' : '') + (isPrivate(o.kind) ? destWords(d.to) : 'to wallet'), amt: `${amt(o.x, r.x)} ${o.x} + ${amt(o.y, r.y)} ${o.y}` },
      }),
    });
  };
  return (
    <>
      <h3 id="dlgTitle">Withdraw order<Tip term="orderWithdraw" align="l" /></h3>
      <Amounts rows={rows} />
      {o.kind === 'shielded' ? <Hint icon="lock">A proof spends your order notes; the order&apos;s unfilled and filled parts come back as new notes.</Hint>
        : o.kind === 'private' ? dest.node : <PublicHint />}
      <ErrorLine id="oErr">{err}</ErrorLine>
      <button className="btn" type="button" id="oGo" onClick={go}>Withdraw order</button>
    </>
  );
}
