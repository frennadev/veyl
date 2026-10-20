'use client';
// Sealed batch swaps: a pool's current batch (read every 4 s on its page), this account's sealed swaps, the batch box with
// its countdown, and a sealed swap's row with its claim or refund. A swap's size is encrypted to the batch committee, which
// only ever decrypts the batch's totals.
import { useEffect, useMemo, useState } from 'react';
import { Icon, Tip } from '@/components/ui/primitives';
import { runAction } from '@/features/actions/runAction';
import { engine, useSession } from '@/features/session/session';
import { networkKey, queryClient, useChainQuery } from '@/features/session/query';
import { tiny } from '@/lib/format';
import { tl } from '@/features/pools/label';
import type { Batch, PoolConfig, SealedState, SealedSwap } from '@/lib/veyl/types';

export interface SealedRead { st: SealedState | null; at: number; mine: SealedSwap[] }
const NONE = { st: null, at: 0 };
const POOL_MS = 4000, SLOT_MS = 400;

export function useSealedPool(pool: PoolConfig | null): SealedRead {
  const live = useSession((s) => !!s.rt?.engine && s.rpc !== 'down');
  const r = useChainQuery<{ st: SealedState | null; at: number }>(['sealedState', pool?.address], live && pool?.address ? async () => {
    let st: SealedState;
    try { st = await engine().sealedState(pool); } catch (e) { st = { enabled: false, err: String((e as Error).message || e) }; }
    return { st, at: Date.now() };
  } : null, { initial: NONE, intervalMs: POOL_MS, staleMs: 2_000, keepPrevious: false, placeholder: () => sealedFromList(pool?.address ?? undefined) });
  const mine = useMySealedSwaps();
  return useMemo(() => ({ ...r.data, mine }), [r.data, mine]);
}

/// This account's sealed swaps in every pool (found by scanning this device's notes): account-specific, never persisted;
/// shared by the sealed page and every pool's batch box.
export function useMySealedSwaps(): SealedSwap[] {
  const live = useSession((s) => !!s.rt?.engine && s.rpc !== 'down');
  return useChainQuery<SealedSwap[]>(['mySealedSwaps'], live ? () => engine().mySealedSwaps() : null, { initial: NO_SWAPS, intervalMs: POOL_MS * 2, account: true }).data;
}
const NO_SWAPS: SealedSwap[] = [];
/// A pool's batch from the sealed page's cached read, until its own read lands.
function sealedFromList(addr: string | undefined): { st: SealedState; at: number } | undefined {
  if (!addr) return undefined;
  for (const q of queryClient.getQueryCache().findAll({ queryKey: [networkKey(), 'sealedPools'] })) {
    const f = (q.state.data as { p: PoolConfig; st: SealedState; at: number }[] | null | undefined)?.find((x) => x.p.address === addr); if (f) return { st: f.st, at: f.at };
  }
  return undefined;
}

/// A sealed pool can take a swap now: enabled, not paused, a committee registered and a batch running.
export const sealedOpen = (st: SealedState | null): st is SealedState & { batch: Batch } => !!(st?.enabled && !st.paused && st.committee && st.batch);
/// Milliseconds until the batch closes: the slots left at the read, minus the time since.
export function msLeft(st: SealedState | null, at: number): number {
  if (!st?.batch || st.slot == null) return 0;
  return Math.max(0, (Number(st.batch.endSlot) - Number(st.slot)) * (st.slotMs || SLOT_MS) - (Date.now() - at));
}
export const mmss = (ms: number) => { const t = Math.ceil(ms / 1000), m = Math.floor(t / 60); return m + ':' + String(t % 60).padStart(2, '0'); };
/// Re-renders every second (countdowns).
export function useSecond() { const [, set] = useState(0); useEffect(() => { const t = setInterval(() => set((n) => n + 1), 1000); return () => clearInterval(t); }, []); }

const units = (sym: string, v: string | bigint) => engine().fmt(sym, BigInt(v));

/// The current batch: countdown, sellers per side (never amounts), the k-floor rule, the last batch's public outcome.
export function SealBox({ pool: p, read }: { pool: PoolConfig; read: SealedRead }) {
  useSecond();
  const sbx = useSession((s) => s.rt?.mode === 'sandbox');
  const ss = read.st!, b = ss.batch!, left = msLeft(ss, read.at), epoch = Number(ss.epochSlots) * (ss.slotMs || SLOT_MS), open = b.state === 'open';
  const done = open ? Math.min(100, Math.max(0, 100 - (left / epoch) * 100)) : 100;
  const state = ss.demo ? 'Sample batch' : open ? (b.rollovers > 0 ? `Open · extended ${b.rollovers}×` : 'Open') : b.state === 'closed' ? 'Sealed · the committee decrypts its totals' : b.state;
  return (
    <div className="bt" id="sealBox" aria-live="polite">
      <div className="top"><b>Batch {b.seq}<Tip term="batch" align="l" /></b><span className={'pill ' + (open ? 'priv' : 'flat')}><Icon name="lock" />{state}</span><Tip term="committee" align="r" /></div>
      {open && <>
        <div className="top"><span className="clock" id="sealClock">{mmss(left)}</span><small>{left > 0 ? 'until it closes' : 'closing now'}</small></div>
        <div className="bar"><i id="sealBar" style={{ width: done.toFixed(1) + '%' }}></i></div>
      </>}
      <div className="sides"><div><span>Selling {tl(p.x)}<Tip term="sellers" align="l" /></span><b>{b.count[0]}</b></div><div><span>Selling {tl(p.y)}</span><b>{b.count[1]}</b></div></div>
      <small><Tip term="kFloor" align="l" /> Sellers, never amounts. A side settles with at least {ss.kMin} sellers or none; short of that the batch runs another epoch{ss.maxRollovers ? ` (up to ${ss.maxRollovers} times)` : ''}, then refunds.
        {sbx && ' In the demo the epoch is 20 s, and bots seal small swaps so batches fill; a batch waits for a proof you are still making.'}</small>
      <LastBatch pool={p} last={ss.last} />
    </div>
  );
}

function LastBatch({ pool: p, last: L }: { pool: PoolConfig; last?: Batch | null }) {
  if (!L) return null;
  let text = '';
  if (L.state === 'settled') {
    const r0 = Number(L.den[0]) > 0 ? units(p.y, L.num[0]) / units(p.x, L.den[0]) : null, r1 = Number(L.den[1]) > 0 ? units(p.y, L.den[1]) / units(p.x, L.num[1]) : null;
    text = `Batch ${L.seq} settled: ${tiny(units(p.x, L.totals[0]))} ${tl(p.x)} and ${tiny(units(p.y, L.totals[1]))} ${tl(p.y)} sold, ${L.count[0]} + ${L.count[1]} sellers`
      + (r0 != null ? `; sellers of ${tl(p.x)} got ${tiny(r0)} ${tl(p.y)} each` : '') + (r1 != null ? `; buyers paid ${tiny(r1)} ${tl(p.y)} per ${tl(p.x)}` : '') + '.';
  } else if (L.state === 'failed') text = `Batch ${L.seq} did not settle; its swaps are refunded.`;
  else if (L.state === 'closed') text = `Batch ${L.seq} is sealed; the committee is decrypting its totals.`;
  return text ? <small className="last">{text}</small> : null;
}

const ROW: Record<string, [string, string, (x: SealedSwap) => string]> = {
  waiting: ['Submitted', 'flat', (x) => `In batch ${x.seq}, waiting for it to close`],
  sealed: ['Waiting for the batch', 'warn', (x) => `Batch ${x.seq} is closed; the committee decrypts its totals, then it settles`],
  claim: ['Settled', 'good', (x) => `Batch ${x.seq} cleared` + (x.expect != null ? `: your output is ${tiny(engine().fmt(x.other, x.expect))} ${tl(x.other)} before the claim fee` : '')],
  refund: ['Refund', 'warn', (x) => `Batch ${x.seq} did not settle; take your ${tl(x.sym)} back`],
  claimed: ['Claimed', 'flat', (x) => `Batch ${x.seq} · delivered as a hidden note`],
  refunded: ['Refunded', 'flat', (x) => `Batch ${x.seq} · returned as a hidden note`],
  failed: ['Refund', 'warn', (x) => `Batch ${x.seq} failed`],
  unknown: ['Unknown', 'flat', (x) => `Batch ${x.seq}`],
};

function claimSealed(x: SealedSwap) {
  const refund = x.state === 'refund';
  runAction({
    title: refund ? 'Taking your swap back' : 'Claiming your swap', kind: 'proof', exec: (E) => E.sealedClaim(x),
    done: (r) => { const got = `${tiny(engine().fmt(r.sym, r.value))} ${r.sym}`; return {
      title: (refund ? 'Refunded ' : 'Claimed ') + got, tx: r.tx,
      body: refund ? `Batch ${x.seq} did not settle, so your ${tl(x.sym)} came back as a new hidden note (minus the relayer's flat fee).`
        : `Your share of batch ${x.seq} at its clearing price, delivered as a new hidden note. The chain saw a nullifier and a commitment, not the amount.`,
      activity: { t: (refund ? 'Refunded sealed swap · ' : 'Claimed sealed swap · ') + x.pair, s: `Batch ${x.seq} · into a hidden note`, amt: '+' + got },
    }; },
  });
}

export function SealRow({ x }: { x: SealedSwap }) {
  const [label, tone, text] = ROW[x.state] || [x.state, 'flat', () => ''];
  return (
    <div className="row srow" data-seal={x.id}>
      <div className="mid"><b>Sell <span className="sens">{tiny(engine().fmt(x.sym, x.amount))}</span> {tl(x.sym)} for {tl(x.other)} <span className="pill priv"><Icon name="lock" />Sealed</span></b><small>{text(x)}</small></div>
      <div className="rt"><span className={'pill ' + tone}>{label}</span>
        {x.state === 'claim' && <button className="btn sm" type="button" data-sc={x.id} onClick={() => claimSealed(x)}>Claim</button>}
        {x.state === 'refund' && <button className="btn sm ghost" type="button" data-sc={x.id} onClick={() => claimSealed(x)}>Refund</button>}
      </div>
    </div>
  );
}

const RECENT_MS = 36e5;
/// This account's sealed swaps worth listing: anything not yet claimed or refunded, plus what finished in the last hour.
export const activeSealed = (mine: SealedSwap[], pool?: string) =>
  mine.filter((x) => (!pool || x.pool === pool) && ((x.state !== 'claimed' && x.state !== 'refunded') || Date.now() - x.at < RECENT_MS));
