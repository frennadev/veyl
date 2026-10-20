'use client';
// The pool page's action panel (a side column on desktop, a bottom sheet on phones): tabs, Private / Public, the current tab's
// form, then the shared footer (details, who sees what, the button, the hint).
import { Hint, Icon, Tip } from '@/components/ui/primitives';
import { useBalances } from '@/features/portfolio/balances';
import { isLive, useSession } from '@/features/session/session';
import { balanceOf, balanceLabel } from '@/lib/veyl/services/balances';
import { tiny } from '@/lib/format';
import type { PoolView } from '@/lib/veyl/services/pools';
import type { PoolMath } from '../poolMath';
import { setPanel, usePanel, type Source, type Tab } from '../state';
import { Details, Seen } from './parts';
import { TABS, type PanelCtx } from './tabs';
import type { SealedRead } from '@/features/sealed/sealed';

const SOURCES: { id: Source; icon: 'lock' | 'wallet'; title: string; sub: string }[] = [
  { id: 'priv', icon: 'lock', title: 'Private', sub: 'From your private balance. Your wallet stays hidden.' },
  { id: 'pub', icon: 'wallet', title: 'Public', sub: 'Signed by your wallet. Visible on-chain.' },
];

export function Panel({ pool, m, usdY, ivSecs, sealed }: { pool: PoolView; m: PoolMath | null; usdY: number | null; ivSecs: number; sealed: SealedRead }) {
  const s = usePanel();
  const rt = useSession((x) => x.rt), live = useSession((x) => isLive(x)), rpc = useSession((x) => x.rpc), account = useSession((x) => x.account);
  const { b } = useBalances();
  const priv = s.src === 'priv';
  const noNewLiquidity = pool.status === 'delisted' && s.tab !== 'swap';
  const block = !live ? 'Not connected' : rpc === 'down' ? 'Chain not answering' : noNewLiquidity ? 'Delisted: withdrawals only' : !priv && !account ? 'Connect a wallet' : '';
  const bal = (sym: string) => balanceOf(b, s.src, sym);
  const ctx: PanelCtx = {
    pool, m, E: rt?.engine ?? null, sdk: rt?.sdk ?? null, mode: rt?.mode ?? 'preview', s, priv, block, bal, usdY, ivSecs, sealed,
    balText: (sym) => balanceLabel(b, s.src, sym, live, !!account, tiny),
  };
  return (
    <div className={'panel' + (s.sheet ? ' shown' : '')} id="panel" role="dialog" aria-label="Provide, zap, limit order or swap">
      <div className="grab" aria-hidden="true"></div>
      <div className="panel-h">
        <div className="tabs" role="tablist" id="tabs">
          {(Object.keys(TABS) as Tab[]).map((t) => <button key={t} type="button" role="tab" data-tab={t} aria-selected={s.tab === t} onClick={() => setPanel({ tab: t })}>{TABS[t].label}</button>)}
        </div>
        <button className="ib px" id="panelX" type="button" aria-label="Close" onClick={() => setPanel({ sheet: false })}><Icon name="x" /></button>
      </div>
      <div className="lbl"><span>Pay from<Tip term="privatePublic" align="l" /></span></div>
      <div className="src" id="srcSeg" role="group" aria-label="Pay from">
        {SOURCES.map((o) => <button key={o.id} type="button" data-src={o.id} aria-pressed={s.src === o.id} onClick={() => setPanel({ src: o.id })}><b><Icon name={o.icon} size="sm" />{o.title}</b><small>{o.sub}</small></button>)}
      </div>
      <TabView key={s.tab} tab={s.tab} ctx={ctx} />
    </div>
  );
}

function TabView({ tab, ctx }: { tab: Tab; ctx: PanelCtx }) {
  const model = TABS[tab].use(ctx);
  const ready = !model.blocker;
  return (
    <>
      {model.body}
      <Details rows={model.details} />
      <Seen s={model.seen} />
      <button className={'btn' + (ctx.priv ? '' : ' ghost')} id="actGo" type="button" disabled={!ready} onClick={model.run}>{ready ? model.label : model.blocker}</button>
      {model.hint ?? <ActionHint ctx={ctx} />}
    </>
  );
}

function ActionHint({ ctx }: { ctx: PanelCtx }) {
  if (!ctx.E) return <p className="hint" id="actHint"><Icon name="wallet" /><span>Connect a wallet to continue.</span></p>;
  if (ctx.priv) return (
    <p className="hint" id="actHint"><Icon name="lock" /><span>Spends from your shielded balance: up to two notes per token, merged first when it takes more. Proofs are made on this device
      {ctx.mode === 'sandbox' ? ' (several seconds, longer on a phone). For an instant try, pay from the wallet: no proof, all public.' : '.'}</span></p>
  );
  return <Hint id="actHint" icon="alert" tone="warn">Public: linked to your wallet for anyone to read.</Hint>;
}
