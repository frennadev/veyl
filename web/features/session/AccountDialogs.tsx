'use client';
// Getting in: no wallet needed (a deposit address kept in this browser) or a wallet (WalletConnect.tsx). Funding and emptying the
// deposit address. The Sandbox's demo funds and reset.
import { useEffect, useState } from 'react';
import { Icon, Hint, ErrorLine, Tip } from '@/components/ui/primitives';
import { closeModal, copyText, openModal, toast } from '@/components/overlay';
import { runAction } from '@/features/actions/runAction';
import { refreshPublicBalances, useBalances } from '@/features/portfolio/balances';
import { openDeposit } from '@/features/portfolio/MoneyDialogs';
import { balanceOf } from '@/lib/veyl/services/balances';
import { short, tiny, SOLANA_ADDRESS } from '@/lib/format';
import { WalletList } from './WalletConnect';
import { connectLocal, engine, invalidate, isLive, logActivity, session, useSession } from './session';

const NOT_CONNECTED = 'This page isn\'t connected to Solana, so connecting is turned off here.';
export const notConnected = () => toast('This page isn\'t connected to Solana, so nothing can be sent from it.', 'wallet');
const errText = (e: unknown, fallback: string) => (e as Error)?.message || fallback;

// ---------------------------------------------------------------- get started
export const openStart = () => openModal(<StartDialog />);

function StartDialog() {
  const live = useSession((s) => isLive(s));
  const guard = (f: () => Promise<void>) => async () => {
    if (!live) { toast(NOT_CONNECTED, 'wallet', 5000); return; }
    closeModal(); await f();
  };
  const local = guard(async () => {
    try { await connectLocal(); openFund(); } catch (e) { toast(errText(e, 'Could not set up the deposit address.'), 'alert', 6000); }
  });
  return (
    <>
      <h3 id="dlgTitle">Get started</h3>
      <p>No account, no sign-up. Choose how to put money in.</p>
      <button className="opt2 rec" type="button" id="stLocal" onClick={local}>
        <span className="oi"><Icon name="key" /></span>
        <span className="ot"><b>No wallet needed</b><small>Veyl makes a deposit address in this browser. Send SOL, USDC or USDT to it from any wallet or exchange.</small></span>
        <span className="pill priv">Recommended</span>
      </button>
      <div className="orsep"><span>or connect a wallet<Tip term="walletConnect" align="l" /></span></div>
      <WalletList onBlocked={() => toast(NOT_CONNECTED, 'wallet', 5000)} onBack={openStart} />
      <p className="wnote">Your wallet signs deposits. Everything after that is private.</p>
      {!live && <Hint icon="alert">{NOT_CONNECTED}</Hint>}
    </>
  );
}

// ---------------------------------------------------------------- the deposit address
export const openFund = () => openModal(<FundDialog />);

const FUND_REFRESH_MS = 5000;
function FundDialog() {
  const account = useSession((s) => s.account) || '';
  const faucet = useSession((s) => s.faucet);
  const { b } = useBalances();
  useEffect(() => { const t = setInterval(refreshPublicBalances, FUND_REFRESH_MS); return () => clearInterval(t); }, []); // watch it arrive
  return (
    <>
      <h3 id="dlgTitle">Fund your deposit address<Tip term="depositAddress" align="l" /></h3>
      <p>Send tokens here from any wallet or exchange, on Solana. Keep about <b>0.01 SOL</b> in it for network fees<Tip term="solForFees" align="l" />. Then move it into your private balance.</p>
      <div className="faddr"><code>{account}</code><button className="btn ghost" type="button" onClick={() => copyText(account, 'Address copied')}>Copy</button></div>
      <div className="list" id="fBal">
        {Object.keys(engine().tokens).map((k) => <div key={k} className="row"><span className="mid"><b>{k}</b></span><span className="rt"><b className="sens">{tiny(balanceOf(b, 'pub', k))}</b></span></div>)}
      </div>
      {faucet && <FaucetButton style={{ marginBottom: 10 }} />}
      <Hint icon="alert">This address is public, and its key lives only in this browser. Back up from the account menu so you never lose it.</Hint>
      <button className="btn" type="button" id="fGo" onClick={() => { closeModal(); openDeposit(); }}>Move into private balance</button>
    </>
  );
}

export const openSweep = () => openModal(<SweepDialog />);
function SweepDialog() {
  const [to, setTo] = useState(''), [error, setError] = useState('');
  const submit = () => {
    const dest = to.trim(); if (!SOLANA_ADDRESS.test(dest)) return setError('Enter a Solana address.');
    runAction({
      title: 'Sending out', kind: 'wallet', exec: (E) => E.localSweep(dest),
      done: (r) => ({
        title: 'Sent', tx: r.tx, body: r.moved?.length ? `Moved ${r.moved.join(', ')} to ${short(dest)}.` : 'There was nothing to move.',
        activity: { t: 'Deposit address emptied', s: 'To ' + short(dest), amt: (r.moved || []).join(', ') },
      }),
    });
  };
  return (
    <>
      <h3 id="dlgTitle">Send what&apos;s left out<Tip term="sweep" align="l" /></h3>
      <p>Empties the deposit address to a Solana address: every token, then the SOL after fees. This is public, and links the deposit address to where it goes. For privacy, withdraw from your private balance instead.</p>
      <div className="fld"><label htmlFor="swpTo">To</label><input id="swpTo" type="text" placeholder="Solana address" autoComplete="off" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      <ErrorLine id="swpErr">{error}</ErrorLine>
      <button className="btn" type="button" id="swpGo" onClick={submit}>Send out</button>
    </>
  );
}

// ---------------------------------------------------------------- devnet faucet (the relayer's, mock mints only)
/// The relayer's faucet: the core basket, or `tokens` (a pool's own pair).
export function FaucetButton({ style, className = 'btn ghost', tokens, label = 'Get test tokens' }: { style?: React.CSSProperties; className?: string; tokens?: string[]; label?: string }) {
  const [busy, setBusy] = useState(false);
  const drip = async () => {
    const s = session.get(); const relayer = s.rt?.cfg?.relayer;
    if (!s.account) { openStart(); return; }
    setBusy(true);
    try {
      const r = await fetch(relayer + '/drip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tokens ? { to: s.account, tokens } : { to: s.account }) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || 'The faucet did not answer.');
      toast('Sent: ' + (j.sent || []).join(', '), 'check', 7000); logActivity({ t: 'Test tokens received', s: 'Devnet faucet', amt: '' }); invalidate();
    } catch (e) { toast(errText(e, 'The faucet did not answer.'), 'alert', 6000); } finally { setBusy(false); }
  };
  return <button className={className} type="button" data-drip={tokens ? tokens.join(',') : ''} style={style} disabled={busy} onClick={drip}>{busy ? 'Sending…' : label}</button>;
}

// ---------------------------------------------------------------- sandbox
export function topUp() {
  const rt = session.get().rt; if (rt?.mode !== 'sandbox') return;
  runAction({
    title: 'Topping up', kind: 'wallet', exec: () => rt.engine.faucet(),
    done: () => {
      const sb = rt.engine.store.data.sandbox || (rt.engine.store.data.sandbox = {}); sb.seen ||= Date.now(); rt.engine.store.save();
      return { title: 'Topped up', body: 'Your wallet and private balance have been topped up.', activity: { t: 'Top up', s: 'Demo funds', amt: '' } };
    },
  });
}
export const openStartOver = () => openModal(<StartOverDialog />);
function StartOverDialog() {
  const reset = () => { const rt = session.get().rt; if (rt?.mode === 'sandbox') { rt.engine.reset(); location.href = location.pathname; } };
  return (
    <>
      <h3 id="dlgTitle">Start over?</h3>
      <p>Pools, prices, your wallet, your shielded account and its history go back to the start. Only this browser is affected.</p>
      <button className="btn" type="button" id="rsYes" onClick={reset}>Reset</button>
    </>
  );
}
