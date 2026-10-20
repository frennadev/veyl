'use client';
// Sealed swaps: every pool with sealed batches and its current batch, and this account's sealed swaps in all of them.
import { tl } from '@/features/pools/label';
import { Icon, PairLogo, Dash, Tip } from '@/components/ui/primitives';
import { setPanel } from '@/features/pool/state';
import { usePoolConfigs } from '@/features/pools/usePoolViews';
import { engine, isLive, useSession } from '@/features/session/session';
import { useChainQuery } from '@/features/session/query';
import { openPool } from '@/features/shell/router';
import type { PoolConfig, SealedState, SealedSwap } from '@/lib/veyl/types';
import { SealRow, activeSealed, mmss, msLeft, useMySealedSwaps, useSecond } from './sealed';

const REFRESH_MS = 8000, RESCAN_MS = 60_000, CONCURRENCY = 6;
type Found = { p: PoolConfig; st: SealedState; at: number };

/// Which pools have sealed batches: found by asking every listed pool (a few at a time) once a minute; the refreshes in
/// between read only those.
const scan = { ids: null as Set<string> | null, at: 0 };

async function readSealed(configs: PoolConfig[], emit: (f: Found[]) => void): Promise<Found[]> {
  const E = engine(); const full = !scan.ids || Date.now() - scan.at > RESCAN_MS;
  const ask = configs.filter((p) => p.address && p.status !== 'delisted' && (full || scan.ids!.has(p.id)));
  const found = new Map<string, Found>();
  const order = () => configs.map((p) => found.get(p.id)).filter((x): x is Found => !!x);
  const queue = [...ask];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try { const st = await E.sealedState(p); if (st?.enabled) { found.set(p.id, { p, st, at: Date.now() }); emit(order()); } } catch { /* not sealed here */ }
    }
  }));
  if (full) scan.ids = new Set(found.keys()), scan.at = Date.now();
  return order();
}

/// The sealed pools' current batches (public; kept in memory, so coming back to the page shows them at once).
export function useSealedPools(): { pools: Found[]; read: boolean } {
  const live = useSession((s) => isLive(s));
  const configs = usePoolConfigs();
  const sig = configs.map((c) => c.id + ':' + (c.status || '')).join(',');
  const r = useChainQuery<Found[] | null>(['sealedPools', sig], live ? (emit) => readSealed(configs, emit) : null, { initial: null, intervalMs: REFRESH_MS, staleMs: 4_000 });
  return { pools: r.data || [], read: r.data != null };
}

export default function SealedPage() {
  useSecond();
  const live = useSession((s) => isLive(s));
  const all = useSealedPools(), mySwaps = useMySealedSwaps();
  const r = { data: { pools: all.pools, read: all.read, mine: mySwaps } };
  const sealHere = (id: string) => { openPool(id); setPanel({ tab: 'swap', swMode: 'sealed', src: 'priv' }); };
  const mine = activeSealed(r.data.mine);
  return (
    <section className="page" id="pg-sealed">
      <div className="ph"><div><h1>Sealed swaps<Tip term="batch" align="l" /></h1><p>Your swap size stays hidden. Everyone in a batch gets the same price.</p></div></div>
      <div className="sealgrid" id="sealPools">
        {!live ? <div className="card empty">No sealed batches right now.</div>
          : !r.data.read ? <div className="card empty">Reading batches…</div>
            : !r.data.pools.length ? <div className="card empty">No sealed batches right now.</div>
              : r.data.pools.map(({ p, st, at }) => { const b = st.batch, open = b?.state === 'open'; return (
                <div key={p.id} className="card sealcard">
                  <div className="top"><span className="pp"><PairLogo x={p.x} y={p.y} /><b style={{ fontWeight: 500 }}>{tl(p.x)}–{tl(p.y)}</b></span><span className={'pill ' + (open ? 'priv' : 'flat')}><Icon name="lock" />Batch {b ? `${b.seq} · ${b.state}` : '—'}</span></div>
                  <dl className="det">
                    <div><dt>Closes in<Tip term="batchCloses" align="l" /></dt><dd>{!open ? 'sealing' : msLeft(st, at) > 0 ? mmss(msLeft(st, at)) : 'closing now'}</dd></div>
                    <div><dt>Sellers, {tl(p.x)} / {tl(p.y)}<Tip term="sellers" align="l" /></dt><dd>{b ? `${b.count[0]} / ${b.count[1]}` : <Dash />}</dd></div>
                    <div><dt>Last batch<Tip term="lastBatch" align="l" /></dt><dd>{st.last ? `${st.last.seq} · ${st.last.state}` : 'none yet'}</dd></div>
                  </dl>
                  <button className="btn sm ghost" type="button" data-pool={p.id} data-sealtab="" onClick={() => sealHere(p.id)}>Seal a swap in {tl(p.x)}–{tl(p.y)}</button>
                </div>
              ); })}
      </div>
      <div className="sec"><h2>Your sealed swaps</h2></div>
      <div className="list" id="sealMine">
        {live && (mine.length ? mine.map((x) => <SealRow key={x.id} x={x} />) : <div className="card empty">No sealed swaps yet. Pick a pool above and seal a swap into its next batch.</div>)}
      </div>
    </section>
  );
}
