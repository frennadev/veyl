'use client';
// The Swap page: any token to any other, routed on this device through Veyl's pools (direct, or through one hub), paid from
// the private balance (a proof, the relayer submits) or the wallet (public).
import { tl } from '@/features/pools/label';
import { useState } from 'react';
import { Hint, Icon, TokenLogo, Tip } from '@/components/ui/primitives';
import { closeModal, openModal } from '@/components/overlay';
import { runAction } from '@/features/actions/runAction';
import { useBalances } from '@/features/portfolio/balances';
import { Seen } from '@/features/pool/panel/parts';
import { engine, isLive, useSession } from '@/features/session/session';
import { cleanAmount, maxAmount, tiny } from '@/lib/format';
import { tokenName } from '@/lib/tokens';
import { useAsyncQuery } from '@/features/session/query';
import { balanceLabel, balanceOf } from '@/lib/veyl/services/balances';
import { quoteFees } from '@/lib/veyl/services/pools';
import { createStore, useStore } from '@/lib/store';

type Source = 'priv' | 'pub';
const swap = createStore<{ a: string; b: string; src: Source; amount: string }>({ a: 'USDC', b: 'SOL', src: 'priv', amount: '' });

const SOURCES: { id: Source; icon: 'lock' | 'wallet'; title: string; sub: string }[] = [
  { id: 'priv', icon: 'lock', title: 'Private', sub: 'From your private balance. Your wallet stays hidden.' },
  { id: 'pub', icon: 'wallet', title: 'Public', sub: 'Signed by your wallet. Visible on-chain.' },
];

export default function SwapPage() {
  const s = useStore(swap, (x) => x);
  const live = useSession((x) => isLive(x)), rpc = useSession((x) => x.rpc), account = useSession((x) => x.account);
  const { b: bal } = useBalances();
  const priv = s.src === 'priv', v = cleanAmount(s.amount).value;
  const have = (sym: string) => balanceOf(bal, s.src, sym);
  const label = (sym: string) => { const t = balanceLabel(bal, s.src, sym, live, !!account, tiny); return t ? 'Balance ' + t.replace(' ' + sym, '') : ''; };
  const q = useAsyncQuery('swapQuote', live && v > 0 ? async () => {
    const E = engine(); const best = await E.quoteRoute(s.a, s.b, E.unit(s.a, v));
    return best ? { out: E.fmt(s.b, best.out), path: best.path as { name: string; out: string }[], fees: quoteFees(E, s.a, best) } : { out: null, path: [], fees: null };
  } : null, [s.a, s.b, v], 250);
  const quote = q.value && q.key === JSON.stringify([s.a, s.b, v]) ? q.value : null;
  const block = !live ? 'Not connected' : rpc === 'down' ? 'Chain not answering' : !priv && !account ? 'Connect a wallet' : '';
  const why = block || (!(v > 0) ? 'Enter an amount' : v > have(s.a) + 1e-12 ? 'Not enough ' + s.a : q.error ? 'Quote unavailable' : !quote ? 'Quoting…' : quote.out == null ? 'No route' : '');
  const go = () => {
    const { a, b } = s;
    runAction({
      title: 'Swapping', kind: priv ? 'proof' : 'wallet', exec: (E) => (priv ? E.swap(a, b, v) : E.swapPublic(a, b, v)),
      done: (r) => { swap.set({ amount: '' }); const got = tiny(engine().fmt(b, r.out)); return {
        title: `Got ${got} ${b}`, tx: r.tx,
        body: priv ? 'Routed through Veyl pools into a new shielded note. The amounts were public at the pool; nothing on-chain connects them to you.' : 'Settled to your wallet.',
        activity: { t: `Swapped ${a} → ${b}`, s: `${priv ? 'Private' : 'Public'} · via ${r.route.join(' → ')}`, amt: `+${got} ${b}` },
      }; },
    });
  };
  const max = () => swap.set({ amount: maxAmount(have(s.a)) });
  return (
    <section className="page" id="pg-swap">
      <div className="swapwrap">
        <div className="ph"><div><h1>Swap</h1></div></div>
        <div className="lbl"><span>Pay from<Tip term="privatePublic" align="l" /></span></div>
        <div className="src" id="swSrc" role="group" aria-label="Pay from">
          {SOURCES.map((o) => <button key={o.id} type="button" data-src={o.id} aria-pressed={s.src === o.id} onClick={() => swap.set({ src: o.id })}><b><Icon name={o.icon} size="sm" />{o.title}</b><small>{o.sub}</small></button>)}
        </div>
        <div className="swcard">
          <div className="amt">
            <div className="b"><span>You pay</span><span><span className="sens" id="swBalIn">{label(s.a)}</span><button type="button" id="swMax" onClick={max}>Max</button></span></div>
            <div className="m"><input id="swIn" type="text" inputMode="decimal" placeholder="0" autoComplete="off" aria-label="Amount to pay" value={s.amount} onChange={(e) => swap.set({ amount: cleanAmount(e.target.value).text })} />
              <TokenButton id="swTokIn" sym={s.a} onClick={() => openPicker('a', s.src)} /></div>
          </div>
          <button className="flip" type="button" id="swFlip" aria-label="Switch tokens" onClick={() => swap.set({ a: s.b, b: s.a, amount: '' })}><Icon name="swap" /></button>
          <div className="amt">
            <div className="b"><span>You receive</span><span className="sens" id="swBalOut">{label(s.b)}</span></div>
            <div className="m"><input id="swOut" type="text" readOnly tabIndex={-1} aria-label="Amount you receive" value={quote?.out != null ? tiny(quote.out) : v > 0 && live ? '…' : ''} />
              <TokenButton id="swTokOut" sym={s.b} onClick={() => openPicker('b', s.src)} /></div>
          </div>
        </div>
        {q.error && <p className="err" role="alert">The quote could not be loaded. Check your connection. <button type="button" className="btn sm ghost" onClick={q.retry}>Try again</button></p>}
        <Route live={live} a={s.a} v={v} quote={quote} priv={priv} />
        <Seen s={priv ? { hidden: 'Your wallet. The output lands in a new note on this device.', pub: 'The route, the amounts in and out, the relayer fee.' } : { hidden: 'Nothing.', pub: 'Your wallet and the whole swap.' }} />
        <button className={'btn' + (priv ? '' : ' ghost')} type="button" id="swGo" disabled={!!why} onClick={go}>{why || (priv ? <><Icon name="lock" size="sm" />Swap privately</> : 'Swap from wallet')}</button>
        {priv ? <Hint id="swHint" icon="lock">The chain sees a swap through the pools, not who made it.</Hint> : <Hint id="swHint" icon="alert" tone="warn">This swap is public and linked to your wallet.</Hint>}
      </div>
    </section>
  );
}

const TokenButton = ({ id, sym, onClick }: { id: string; sym: string; onClick: () => void }) => (
  <button className="tsel" type="button" id={id} onClick={onClick}><TokenLogo sym={sym} className="" />{tl(sym)}<svg className="ic xs"><use href="#i-down" /></svg></button>
);

function Route({ live, a, v, quote, priv }: { live: boolean; a: string; v: number; quote: { out: number | null; path: { name: string; out: string }[]; fees?: { lp: number; protocol: number } | null } | null; priv: boolean }) {
  const top = (extra?: React.ReactNode) => <div className="top"><b>Route</b>{extra}</div>;
  const note = (t: string) => <p className="dim" style={{ margin: 0 }}>{t}</p>;
  return (
    <div className="route" id="swRoute">
      {!live ? <>{top()}{note('Routes are computed on this device from the pools\' on-chain bins: direct, or through one hub.')}</>
        : quote && quote.out != null ? <>
          {top(<span className="pill flat">{quote.path.length}{quote.path.length > 1 ? ' hops' : ' hop'}</span>)}
          <div className="path"><span className="node"><TokenLogo sym={a} className="" />{a}</span>
            {quote.path.map((h, i) => <span key={i} style={{ display: 'contents' }}><span className="dim"><Icon name="right" size="sm" /></span><span className="node"><TokenLogo sym={h.out} className="" />{h.out}</span></span>)}</div>
          <dl className="det">
            <div><dt>Rate</dt><dd>1 {a} = {tiny(quote.out / v)} {quote.path[quote.path.length - 1]?.out}</dd></div>
            <div><dt>Pools</dt><dd>{quote.path.map((h) => h.name).join(' · ')}</dd></div>
            {quote.fees && <><div><dt>Pool fee<Tip term="feeTier" align="l" /></dt><dd>{tiny(quote.fees.lp)} {a}</dd></div>
              <div><dt>Protocol fee<Tip term="protocolFee" align="l" /></dt><dd>{tiny(quote.fees.protocol)} {a}</dd></div></>}
            <div><dt>Slippage limit<Tip term="slippage" align="l" /></dt><dd>1%</dd></div>
            <div><dt>Network fee<Tip term="networkFee" align="l" /></dt><dd>{priv ? 'Relayer, a flat fee' : '≈ 0.00001 SOL'}</dd></div>
          </dl>
        </> : quote ? <>{top()}{note('No route with liquidity for this pair right now.')}</> : <>{top()}{note('Enter an amount to see the best route.')}</>}
    </div>
  );
}

function openPicker(side: 'a' | 'b', src: Source) { openModal(<TokenPicker side={side} src={src} />); }
function TokenPicker({ side, src }: { side: 'a' | 'b'; src: Source }) {
  const { b: bal } = useBalances(); const [syms] = useState(() => Object.keys(engine().tokens));
  const pick = (k: string) => {
    swap.set((s) => side === 'a' ? { a: k, b: k === s.b ? s.a : s.b } : { b: k, a: k === s.a ? s.b : s.a });
    closeModal();
  };
  return (
    <>
      <h3 id="dlgTitle">Select a token</h3>
      <div className="plist">
        {syms.map((k) => (
          <button key={k} className="row" type="button" data-pick={k} onClick={() => pick(k)}>
            <TokenLogo sym={k} /><div className="mid"><b>{tl(k)}</b><small>{tokenName(tl(k))}</small></div><div className="rt"><b className="sens">{tiny(balanceOf(bal, src, k))}</b></div>
          </button>
        ))}
      </div>
    </>
  );
}
