'use client';
// Activity: this device's own log of what it did (kept in this browser only), and on a real chain the latest swaps through
// the deployment's pools as read from the chain.
import { useSession } from '@/features/session/session';
import { Tip } from '@/components/ui/primitives';
import { useSecond } from '@/features/sealed/sealed';
import { age, tiny } from '@/lib/format';
import type { ActivityEntry } from '@/lib/veyl/types';

const LEDGER_ROWS = 40;

export function ActivityRow({ a }: { a: ActivityEntry }) {
  return <div className="row"><div className="mid"><b>{a.t}</b><small>{a.s} · {age(Date.now() - a.ts)} ago</small></div><div className="rt"><b className="sens">{a.amt || ''}</b></div></div>;
}

export default function ActivityPage() {
  useSecond();
  const activity = useSession((s) => s.activity);
  const rt = useSession((s) => s.rt);
  return (
    <section className="page" id="pg-activity">
      <div className="narrow page" style={{ padding: 0 }}>
        <div className="ph"><div><h1>Activity</h1><p>Kept in this browser only.</p></div></div>
        <div className="list" id="actList">
          {activity.length ? activity.map((a, i) => <ActivityRow key={a.ts + ':' + i} a={a} />)
            : <div className="card empty">No activity yet. Deposits, swaps, positions and orders show up here, visible only on this device.</div>}
        </div>
        {rt?.mode === 'chain' && <ChainLedger />}
      </div>
    </section>
  );
}

function ChainLedger() {
  const rt = useSession((s) => s.rt);
  if (rt?.mode !== 'chain') return null;
  const E = rt.engine, cfg = rt.cfg, rows = E.recentChain(LEDGER_ROWS);
  return (
    <div id="ledgerWrap">
      <div className="sec"><h2>On-chain swaps<Tip term="onChainSwaps" align="l" /></h2></div>
      <p className="dim" style={{ margin: '-4px 0 10px', fontSize: '13.5px' }}>The most recent swaps through the deployment&apos;s pools, read from {rt.chainName}.</p>
      <div className="list ledger" id="ledger">
        {rows.length ? rows.map((x) => { const sym = x.xForY ? x.x : x.y; return (
          <div key={x.sig} className="row">
            <div className="mid"><b>{x.xForY ? `${x.x} → ${x.y}` : `${x.y} → ${x.x}`} · {x.x}–{x.y}</b>
              <small><code>{x.sig.slice(0, 10)}…</code> · {age(Date.now() - x.t * 1000)} ago{cfg.explorer && <> · <a href={`${cfg.explorer}/tx/${x.sig}${cfg.explorerSuffix || ''}`} target="_blank" rel="noopener">view</a></>}</small></div>
            <div className="rt"><b>{tiny(E.fmt(sym, x.amountIn))} {sym}</b></div>
          </div>
        ); }) : <div className="card empty">No swaps read yet.</div>}
      </div>
    </div>
  );
}
