'use client';
// A pool's listing state on its page (open pool creation): a notice for new (unverified) and delisted pools, and the
// creator's refundable bond with its release. Nothing renders for verified pools or on engines without these fields.
import { Banner, Tip } from '@/components/ui/primitives';
import { runAction } from '@/features/actions/runAction';
import { engine, useSession } from '@/features/session/session';
import { useChainQuery } from '@/features/session/query';
import type { PoolView } from '@/lib/veyl/services/pools';
import type { BondInfo } from '@/lib/veyl/types';
import { tl } from '@/features/pools/label';

const BOND_MS = 60_000;
const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function StatusNotice({ pool: p }: { pool: PoolView }) {
  if (p.status === 'delisted') return (
    <Banner icon="alert" tone="bad" title="This pool was delisted">You can withdraw everything you have in it. Nobody can add liquidity or place orders here any more.</Banner>
  );
  if (p.status === 'unverified') return (
    <Banner icon="alert" tone="warn" title={<>New pool, not verified yet<Tip term="unverified" align="l" /></>}>
      Anyone can create a pool. Check that {tl(p.x)} and {tl(p.y)} are the tokens you expect{p.mintX && p.mintY ? <> (mints <code>{p.mintX.slice(0, 4)}…{p.mintX.slice(-4)}</code> and <code>{p.mintY.slice(0, 4)}…{p.mintY.slice(-4)}</code>)</> : null} before you add money.
      {' '}Private liquidity may not work in a new pool until Veyl adds it to its address tables; if a private add fails, try again later or add from your wallet. Sealed swaps open later too.
      {p.crowd != null && <> {p.crowd === 0 ? 'Nobody provides liquidity here yet' : `${p.crowd} ${p.crowd === 1 ? 'person provides' : 'people provide'} liquidity here`}, so there are {p.crowd < 10 ? 'few' : 'some'} to blend in with.<Tip term="poolCrowd" align="l" /></>}
    </Banner>
  );
  return null;
}

/// The creator's bond: shown to everyone as a pool parameter-style card; the creator can release it once the lock ends.
export function BondCard({ pool: p }: { pool: PoolView }) {
  const has = useSession((s) => !!s.rt?.engine?.bond), account = useSession((s) => s.account);
  const r = useChainQuery<BondInfo | null>(['bond', p.address], has && p.address ? () => engine().bond!(p.address!) : null, { initial: null, intervalMs: BOND_MS, account: true }); // `mine` depends on who is connected
  const b = r.data; if (!b) return null;
  const sol = Number(b.amount) / 1e9, mine = b.mine ?? (!!account && b.creator === account);
  const release = () => runAction({
    title: 'Releasing the bond', kind: 'wallet', exec: (E) => E.releaseBond!(p.address!),
    done: (x) => ({ title: 'Bond released', tx: x.tx, body: `${sol} SOL went back to your wallet. The pool stays open and is now verified.`, activity: { t: `Bond released · ${tl(p.x)}–${tl(p.y)}`, s: 'Back to your wallet', amt: `+${sol} SOL` } }),
  });
  return (
    <div className="card pad" id="bondCard">
      <div className="sec" style={{ margin: '0 0 8px' }}><h2>{mine ? 'Your bond' : 'Creator bond'}<Tip term="bond" align="l" /></h2></div>
      <dl className="params">
        <div><dt>Bond</dt><dd>{sol} SOL</dd></div>
        <div><dt>{b.releasable ? 'Lock ended' : 'Locked until'}</dt><dd>{day(b.lockedUntil)}</dd></div>
      </dl>
      {mine && <button className="btn sm" type="button" id="bondGo" disabled={!b.releasable} onClick={release} style={{ marginTop: 10 }}>
        {b.releasable ? 'Release my bond' : `Releasable from ${day(b.lockedUntil)}`}</button>}
    </div>
  );
}
