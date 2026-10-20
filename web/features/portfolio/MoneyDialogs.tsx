'use client';
// Deposit (public wallet → private balance), Send privately (to a Veyl address inside the pool, or out to a Solana address)
// and Receive (QR code + payment link). Wording and ids as in the legacy app.
import { useMemo, useState } from 'react';
import { Field, Hint, ErrorLine, Tip } from '@/components/ui/primitives';
import { copyText, openModal, toast } from '@/components/overlay';
import { runAction } from '@/features/actions/runAction';
import { engine, session, useSession } from '@/features/session/session';
import { balanceOf, covers } from '@/lib/veyl/services/balances';
import { short, tiny, SOLANA_ADDRESS, VEYL_ADDRESS, cleanAmount } from '@/lib/format';
import { useBalances } from './balances';
import { openBackupThen } from '@/features/backup/BackupDialogs';
import type { VeylEngine } from '@/lib/veyl/types';
import { AssetPicker, useTokenAmount, tokenSyms } from './fields';

// ---------------------------------------------------------------- deposit
export const openDeposit = () => openModal(<DepositDialog />);

function DepositDialog() {
  useSession((s) => s.version);
  const [, refresh] = useState(0);
  if (engine().backupStepNeeded()) return <BackupStep onAck={() => refresh((n) => n + 1)} />;
  return <DepositForm />;
}

/// Before the first real deposit: a backup is the only way to recover a private balance, so it comes first. The engine
/// refuses the deposit until there is one or the risk is accepted here.
function BackupStep({ onAck }: { onAck: () => void }) {
  return (
    <>
      <h3 id="dlgTitle">Back up before you deposit</h3>
      <p>Your private balance opens only with keys kept in this browser. If you clear it, lose this device or move to another one without a backup, the money is gone for good. Nobody can recover it, not even Veyl.</p>
      <div className="list" id="dBackup" style={{ gap: 10 }}>
        <button className="btn" type="button" id="dBkGo" data-backup="export" onClick={() => openBackupThen(openDeposit)}>Back up now</button>
        <button className="btn ghost" type="button" id="dAck" onClick={() => { engine().ackNoBackup(); onAck(); }}>Continue without a backup</button>
      </div>
      <Hint icon="key">Takes a minute. You choose a passphrase, then the deposit carries on.</Hint>
    </>
  );
}

function DepositForm() {
  const f = useTokenAmount();
  const { b } = useBalances();
  const isLocal = useSession((s) => s.isLocal), account = useSession((s) => s.account) || '';
  const sbx = useSession((s) => s.rt?.mode === 'sandbox');
  const have = balanceOf(b, 'pub', f.sym);
  const submit = () => {
    const v = f.value;
    if (!(v > 0)) return f.setError('Enter an amount above zero.');
    if (!covers(have, v)) return f.setError(`Your wallet has ${tiny(have)} ${f.sym}.`);
    const sym = f.sym;
    runAction({
      title: 'Depositing', kind: 'wallet', exec: (E) => E.deposit(sym, v),
      done: (r) => ({
        title: `Deposited ${tiny(v)} ${sym}`, tx: r.tx,
        body: sbx ? 'The approved-set publisher admits it into the shielded pool in a few seconds.'
          : 'The approved-set publisher admits it into the shielded pool, usually within seconds; until then you can take it back. Back up your keys: they are the only key to these funds.',
        activity: { t: 'Deposited to shielded balance', s: 'From ' + short(account), amt: `+${tiny(v)} ${sym}` },
      }),
    });
  };
  return (
    <>
      <h3 id="dlgTitle">Deposit<Tip term="deposit" align="l" /></h3>
      <p>Moves tokens from your {isLocal ? 'deposit address' : 'wallet'} into your private balance. The deposit itself is public: your wallet, the token and the amount. Inside, the notes it creates hide their amounts and owner; what you do with them afterwards is not public.</p>
      <AssetPicker id="dA" value={f.sym} onChange={f.setSym} />
      <Field id="dAmt" label="Amount" hintId="dBal" hint={`${isLocal ? 'In your deposit address: ' : 'In your wallet: '}${tiny(have)} ${f.sym}`}>
        <input id="dAmt" type="text" inputMode="decimal" placeholder="0.00" autoComplete="off" value={f.text} onChange={(e) => f.onAmount(e.target.value)} />
      </Field>
      <ErrorLine id="dErr">{f.error}</ErrorLine>
      <button className="btn" type="button" id="dGo" onClick={submit}>Deposit</button>
    </>
  );
}

// ---------------------------------------------------------------- send privately / withdraw
export interface SendPrefill { to?: string; amt?: number; sym?: string }
export const openSend = (pre: SendPrefill = {}) => openModal(<SendDialog pre={pre} />);

const recipientKind = (to: string) =>
  to.startsWith('veyl:') ? 'Veyl address: stays shielded' : SOLANA_ADDRESS.test(to) ? 'Solana address: leaves the shielded pool' : '';

function SendDialog({ pre }: { pre: SendPrefill }) {
  const f = useTokenAmount(pre.sym, pre.amt ? String(pre.amt) : '');
  const [to, setTo] = useState(pre.to || '');
  const { b } = useBalances();
  const rt = useSession((s) => s.rt);
  const sbx = rt?.mode === 'sandbox' ? rt.engine : null;
  const have = balanceOf(b, 'priv', f.sym);
  const isRequest = !!pre.to && to === pre.to;
  const submit = () => {
    const v = f.value, dest = to.trim(), inside = dest.startsWith('veyl:'); f.setError('');
    if (!(v > 0)) return f.setError('Enter an amount above zero.');
    if (!covers(have, v)) return f.setError(`Your shielded balance has ${tiny(have)} ${f.sym}.`);
    if (!inside && !SOLANA_ADDRESS.test(dest)) return f.setError('Enter a Veyl address (veyl:…) or a full Solana address.');
    const sym = f.sym;
    runAction({
      title: 'Sending privately', kind: 'proof', exec: (E) => E.withdraw(sym, v, dest),
      done: (r) => ({
        title: `Sent ${tiny(v)} ${sym}`, tx: r.tx,
        body: inside
          ? 'Delivered as a note only the receiver can read. On chain: two spent notes and two new ones, no amount.'
            + (sbx && dest === sbx.friendAddress() ? ` Mara's shielded ${sym} here: ${tiny(sbx.fmt(sym, sbx.friendBalance(sym)))}.` : '')
          : `Delivered to ${short(dest)}. On-chain it came from the pool, not from you.`,
        activity: { t: inside ? 'Sent inside the shielded pool' : 'Sent from shielded balance', s: 'To ' + (inside ? 'a Veyl address' : short(dest)), amt: `−${tiny(v)} ${sym}` },
      }),
    });
  };
  return (
    <>
      <h3 id="dlgTitle">{pre.to ? 'Pay privately' : 'Send privately'}</h3>
      <p>From your shielded balance. To a <b>Veyl address</b> it stays inside the pool: nobody sees the amount, the sender or the receiver. To a <b>Solana address</b> it leaves the pool: the amount and the receiver are public, not where it came from.</p>
      <AssetPicker id="wA" value={f.sym} onChange={f.setSym} />
      <Field id="wAmt" label="Amount" hintId="wBal" hint={`Private: ${tiny(have)} ${f.sym}`}>
        <input id="wAmt" type="text" inputMode="decimal" placeholder="0.00" autoComplete="off" value={f.text} onChange={(e) => f.onAmount(e.target.value)} />
      </Field>
      <div className="fld">
        <label htmlFor="wTo">To<Tip term="sendDest" align="l" /></label>
        <input id="wTo" type="text" placeholder="veyl:… or a fresh Solana address" autoComplete="off" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value)} />
        <small id="wKind">{isRequest ? 'Payment request · Veyl address: stays shielded' : recipientKind(to.trim())}</small>
        {sbx && <div className="quick">
          <button type="button" id="wMara" onClick={() => setTo(sbx.friendAddress())}>Mara&apos;s Veyl address</button>
          <button type="button" id="wFresh" onClick={() => setTo(sbx.freshAddress())}>A fresh Solana address</button>
        </div>}
      </div>
      <LinkWarnings sym={f.sym} amount={f.value} to={to.trim()} />
      <ErrorLine id="wErr">{f.error}</ErrorLine>
      <button className="btn" type="button" id="wGo" onClick={submit}>Send</button>
      <Hint icon="lock">The relayer submits and takes a flat fee in the token sent, so the token is visible; the amount is not.</Hint>
    </>
  );
}

/// What an onlooker could use to match this withdrawal to your deposit (same amount, too soon, a small crowd). Hints only:
/// the engine still refuses the unsafe cases (your own wallet, an address with history).
function LinkWarnings({ sym, amount, to }: { sym: string; amount: number; to: string }) {
  if (!(amount > 0) || !to) return null;
  let r: ReturnType<VeylEngine['linkRisks']>; try { r = engine().linkRisks(sym, amount, to); } catch { return null; }
  if (!r.warnings.length) return null;
  return <div className="list" id="wRisks" style={{ gap: 6 }}>{r.warnings.map((w) => <Hint key={w.id} icon="alert" tone="warn">{w.text}</Hint>)}</div>;
}

// ---------------------------------------------------------------- receive: payment requests (link + QR)
export const openReceive = () => openModal(<ReceiveDialog />);

export function payLink(addr: string, amt: number, sym: string): string {
  let q = 'pay=' + encodeURIComponent(addr);
  if (amt > 0) q += '&a=' + encodeURIComponent(String(amt)) + '&t=' + encodeURIComponent(sym);
  return location.origin + location.pathname + '#' + q;
}

/// A payment link in the hash (#pay=veyl:…&a=…&t=…), or null.
export function parsePayLink(hash: string): SendPrefill | null {
  let p: URLSearchParams; try { p = new URLSearchParams(hash.replace(/^#/, '')); } catch { return null; }
  const to = (p.get('pay') || '').trim(); if (!VEYL_ADDRESS.test(to)) return null;
  const amt = parseFloat(p.get('a') || ''); const sym = (p.get('t') || '').toUpperCase();
  return { to, amt: amt > 0 && amt < 1e15 ? amt : 0, sym };
}

type QrFactory = (type: number, level: string) => { addData(s: string): void; make(): void; getModuleCount(): number; isDark(r: number, c: number): boolean };
function QrCode({ text }: { text: string }) {
  const path = useMemo(() => {
    const qrcode = (window as Window & { qrcode?: QrFactory }).qrcode; if (typeof qrcode !== 'function') return null;
    const q = qrcode(0, 'M'); q.addData(text); q.make(); const n = q.getModuleCount(); let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { d, size: n + 8 };
  }, [text]);
  if (!path) return null;
  return (
    <svg className="qrsvg" viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label="QR code of the payment link" shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff" /><path d={path.d} fill="#0A0B09" />
    </svg>
  );
}

function ReceiveDialog() {
  const addr = engine().veylAddress();
  const syms = tokenSyms();
  const [sym, setSym] = useState(syms.includes('USDC') ? 'USDC' : syms[0]);
  const [amt, setAmt] = useState('');
  const v = cleanAmount(amt).value;
  const link = payLink(addr, v > 0 ? v : 0, sym);
  return (
    <>
      <h3 id="dlgTitle">Receive privately<Tip term="paymentLink" align="l" /></h3>
      <p>Share your Veyl address, a link or the QR code. A payment to it lands in your private balance: nobody sees the amount, who sent it or that it was you.</p>
      <div className="rcv">
        <div className="qrbox" id="rQr"><QrCode text={link} /></div>
        <div className="rcvr">
          <Field id="rAmt" label="Amount (optional)">
            <input id="rAmt" type="text" inputMode="decimal" placeholder="Any amount" autoComplete="off" value={amt} onChange={(e) => setAmt(cleanAmount(e.target.value).text)} />
          </Field>
          <AssetPicker id="rA" value={sym} onChange={setSym} />
        </div>
      </div>
      <div className="vaddr">
        <div className="mid"><small>Your Veyl address</small><code className="sens">{addr}</code></div>
        <button className="btn sm ghost" type="button" onClick={() => copyText(addr, 'Address copied')}>Copy</button>
      </div>
      <button className="btn" type="button" id="rLink" data-link={link} onClick={() => copyText(link, 'Payment link copied')}>Copy payment link</button>
      <Hint icon="lock">The link carries only your Veyl address and the amount you typed. It never holds keys. Anyone with it can pay you; nobody can spend from it.</Hint>
    </>
  );
}

/// Opens Send prefilled from a payment link, once the session can send.
export function takePayLink(pre: SendPrefill, notConnected: () => void) {
  const rt = session.get().rt;
  if (!rt?.engine) return notConnected();
  if (pre.to === rt.engine.veylAddress()) return toast('That payment link is your own.', 'alert');
  openSend(pre);
}
