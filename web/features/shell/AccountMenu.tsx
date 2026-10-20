'use client';
// The header's account button and its menu (addresses, deposit-address tools, faucet, backup), and the mode chip (Demo /
// On-chain) with its switcher.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText, toast } from '@/components/overlay';
import { openBackup, openRestore } from '@/features/backup/BackupDialogs';
import { FaucetButton, openFund, openStart, openStartOver, openSweep, topUp } from '@/features/session/AccountDialogs';
import { disconnect, engine, isLive, session, useSession } from '@/features/session/session';
import { ConnectedLogo } from '@/features/session/WalletConnect';
import { rememberMode } from '@/lib/veyl/mode';
import { short } from '@/lib/format';
import { Tip } from '@/components/ui/primitives';
import type { Term } from '@/lib/glossary';
import { useMarketTick } from '@/features/market/market';

/// A header popup that closes on any click outside it (and on Escape).
function useHeaderPop() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('click', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return { open, setOpen, ref, close: () => setOpen(false) };
}

const shortVeyl = (a: string) => a.slice(0, 11) + '…' + a.slice(-6);
const CopyRow = ({ label, value, shown, term }: { label: string; value: string; shown: string; term?: Term }) => (
  <><span className="k">{label}{term && <Tip term={term} align="r" />}</span><button className="btn ghost" type="button" data-copy={value} onClick={() => copyText(value, 'Address copied')}>{shown} · copy</button></>
);

export function AccountButton() {
  const pop = useHeaderPop();
  const mode = useSession((s) => s.rt?.mode), account = useSession((s) => s.account), isLocal = useSession((s) => s.isLocal);
  const connected = mode === 'sandbox' || (mode === 'chain' && !!account);
  const text = !connected ? 'Get started' : isLocal ? 'Deposit address' : short(account || '');
  const onClick = (e: React.MouseEvent) => { e.stopPropagation(); if (!connected) openStart(); else pop.setOpen(!pop.open); };
  const item = (f: () => void) => () => { pop.close(); f(); };
  return (
    <div ref={pop.ref} style={{ display: 'contents' }}>
      <button className={'addr' + (connected ? '' : ' conn')} id="acctBtn" type="button" title={account || undefined} onClick={onClick}>{mode === 'chain' && connected && <ConnectedLogo />}{text}</button>
      <div className="pop" id="acctPop" hidden={!pop.open}>
        {pop.open && connected && (mode === 'sandbox' ? <SandboxMenu account={account || ''} item={item} /> : <ChainMenu account={account || ''} isLocal={isLocal} item={item} />)}
      </div>
    </div>
  );
}

type Item = (f: () => void) => () => void;
function SandboxMenu({ account, item }: { account: string; item: Item }) {
  const va = engine().veylAddress();
  return (
    <>
      <CopyRow label="Demo wallet (public, in this browser)" value={account} shown={short(account)} term="demoWallet" />
      <CopyRow label="Veyl address (to be paid privately)" value={va} shown={shortVeyl(va)} term="veylAddress" />
      <span className="k">Demo</span>
      <button className="btn" type="button" data-faucet="" onClick={item(topUp)}>Top up</button>
      <button className="btn ghost" type="button" data-sbxreset="" onClick={item(openStartOver)}>Start over</button>
    </>
  );
}
function ChainMenu({ account, isLocal, item }: { account: string; isLocal: boolean; item: Item }) {
  const faucet = useSession((s) => s.faucet), wallet = useSession((s) => s.wallet);
  const E = engine(); const va = E.veylAddress();
  const leave = async () => { try { await disconnect(); toast(isLocal ? 'Disconnected. The deposit address stays in this browser.' : 'Wallet disconnected', 'wallet'); } catch { toast('Could not disconnect.', 'alert'); } };
  return (
    <>
      {isLocal ? <>
        <CopyRow label="Deposit address (public, kept in this browser)" value={account} shown={short(account)} term="depositAddress" />
        <button className="btn ghost" type="button" data-fund="" onClick={item(openFund)}>Fund it</button>
        <button className="btn ghost" type="button" data-sweep="" onClick={item(openSweep)}>Send what&apos;s left out</button>
      </> : <CopyRow label={wallet ? 'Wallet · ' + wallet.name : 'Wallet'} value={account} shown={short(account)} term="connectedWallet" />}
      <CopyRow label="Veyl address (to be paid privately)" value={va} shown={shortVeyl(va)} term="veylAddress" />
      {faucet && <FaucetButton />}
      <span className="k">Keys and notes on this device<Tip term="backupCheck" align="r" /></span>
      <button className="btn ghost" type="button" data-backup="export" onClick={item(openBackup)}>Back up (encrypted)</button>
      <button className="btn ghost" type="button" data-backup="import" onClick={item(openRestore)}>Restore from backup</button>
      <span className="k">Connection<Tip term="disconnect" align="r" /></span>
      <button className="btn ghost" type="button" id="acctChange" onClick={item(openStart)}>{isLocal ? 'Connect a wallet instead' : 'Change wallet'}</button>
      <button className="btn ghost" type="button" id="acctOut" onClick={item(leave)}>Disconnect</button>
      {!E.store.ok && <p className="err">This browser blocks local storage. Notes will be lost when you close the page: back them up after every action.</p>}
    </>
  );
}

// ---------------------------------------------------------------- mode chip
function switchMode(to: 'sandbox' | 'chain') {
  const rt = session.get().rt; if (rt?.mode === to) return;
  rememberMode(to); if (rt?.mode === 'sandbox') rt.engine.save(); location.reload();
}

export function ModeChip() {
  const pop = useHeaderPop();
  const live = useSession((s) => isLive(s)), mode = useSession((s) => s.rt?.mode), chain = useSession((s) => s.rt?.chainName || '');
  const hasDeployment = useSession((s) => !!s.rt?.deployed);
  const sbx = mode === 'sandbox';
  const opt = (m: 'sandbox' | 'chain', title: string, sub: ReactNode) => (
    <button className="opt" type="button" role="menuitemradio" data-mode={m === 'sandbox' ? 'sandbox' : 'devnet'} aria-checked={(m === 'sandbox') === sbx} onClick={() => { pop.close(); switchMode(m); }}>
      <span className="rd"></span><b>{title}</b><small>{sub}</small>
    </button>
  );
  // on hover: where the market prices come from, or why there are none (each source tried, in order)
  useMarketTick();
  const market = useSession((s) => s.rt?.market);
  const rt = useSession((s) => s.rt);
  const priced = rt?.mode === 'sandbox' ? rt.engine.marketInfo().live : !!rt?.market?.at;
  const priceChain = market?.why && market.tries?.length ? (priced ? `Market prices: ${market.source} · ` : 'No market price. Each source, in order: ') + market.why() : undefined;
  if (!live) return null;
  return (
    <div ref={pop.ref} style={{ display: 'contents' }}>
      <button className={'mchip' + (sbx ? '' : ' dev')} id="modeBtn" type="button" aria-haspopup="true" aria-expanded={pop.open} title={priceChain}
        aria-label={sbx ? 'Demo. Change mode' : `On-chain: ${chain}. Change mode`} onClick={(e) => { e.stopPropagation(); if (sbx) pop.setOpen(!pop.open); }}>
        <i></i>{sbx ? <><span className="lg">Demo</span><span className="sh">Demo</span></> : <><span className="lg">On-chain <em>· {chain}</em></span><span className="sh">On-chain</span></>}
      </button>
      <div className="mpop" id="modePop" hidden={!pop.open}>
        {opt('sandbox', 'Demo', 'Runs in this browser with demo funds. Real proofs, nothing sent anywhere.')}
        {opt('chain', 'On-chain', hasDeployment ? 'Solana with your wallet.' : 'Not connected from this host yet.')}
        {sbx && <><hr /><div className="mini">
          <button className="btn ghost" type="button" data-faucet="" onClick={() => { pop.close(); topUp(); }}>Top up</button>
          <button className="btn ghost" type="button" data-sbxreset="" onClick={() => { pop.close(); openStartOver(); }}>Start over</button>
        </div></>}
      </div>
    </div>
  );
}
