'use client';
// Connecting a Solana wallet. The list in the Get started dialog updates live (Wallet Standard wallets can register after
// the page loaded), then the "approve in your wallet" step with its errors. Wallets that aren't installed are suggested:
// their site on a computer, or this page inside the wallet's own browser on a phone.
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/primitives';
import { closeModal, openModal, toast } from '@/components/overlay';
import { KNOWN_WALLETS, walletLogo } from '@/lib/walletIcons';
import type { WalletProvider } from '@/lib/veyl/types';
import { connectWallet, isLive, session, useSession } from './session';

/// The wallets in this browser, re-read whenever one registers or leaves.
export function useWallets(): WalletProvider[] {
  const dir = useSession((s) => s.rt?.wallets ?? null);
  const [list, setList] = useState<WalletProvider[]>(() => dir?.list() ?? []);
  useEffect(() => { if (!dir) return; setList(dir.list()); return dir.on(() => setList(dir.list())); }, [dir]);
  return list;
}

export function WalletLogo({ w, className = 'wlogo' }: { w: { name: string; icon: string | null }; className?: string }) {
  const src = walletLogo(w);
  return <span className={className} aria-hidden="true">{src ? <img src={src} alt="" /> : <Icon name="wallet" />}</span>;
}

const isPhone = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/// The wallet rows: installed ones (data-wal = index, as the e2e suites click them), then the known ones that aren't.
export function WalletList({ onBlocked, onBack }: { onBlocked: () => void; onBack: () => void }) {
  const wallets = useWallets();
  const live = useSession((s) => isLive(s));
  const has = (n: string) => wallets.some((w) => w.name.toLowerCase() === n.toLowerCase());
  const phone = isPhone();
  const pick = (w: WalletProvider) => { if (!live) return onBlocked(); openModal(<Connecting w={w} onBack={onBack} />); };
  return (
    <div className="wl" id="walList">
      {wallets.map((w, i) => (
        <button key={w.name + i} className="wrow" type="button" data-wal={i} onClick={() => pick(w)}>
          <WalletLogo w={w} /><b>{w.name}</b><span className="pill good">Detected</span>
        </button>
      ))}
      {KNOWN_WALLETS.filter((k) => !has(k.name)).map((k) => {
        const inApp = phone && !!k.browse;
        return (
          <a key={k.name} className="wrow get" href={inApp ? k.browse!(location.href) : k.site} target={inApp ? undefined : '_blank'} rel="noopener noreferrer">
            <WalletLogo w={{ name: k.name, icon: k.icon() }} /><b>{k.name}</b>
            <span className="wsub">{inApp ? 'Open in app' : 'Install'}<Icon name="ext" size="sm" /></span>
          </a>
        );
      })}
    </div>
  );
}

/// What a wallet's refusal means, in plain words.
function reason(e: unknown, name: string): string {
  const err = e as { code?: number; message?: string; name?: string } | null;
  const m = err?.message || '';
  if (err?.code === 4001 || /reject|declin|denied|cancel/i.test(m)) return `You declined in ${name}. Try again when you're ready.`;
  if (/locked|unlock/i.test(m)) return `${name} is locked. Unlock it, then try again.`;
  return m || `${name} didn't connect.`;
}

function Connecting({ w, onBack }: { w: WalletProvider; onBack: () => void }) {
  const [error, setError] = useState('');
  const mounted = useRef(true), started = useRef(false);
  const go = async () => {
    setError('');
    try {
      await connectWallet(w);
      if (mounted.current) closeModal();
      toast(w.name + ' connected', 'wallet');
    } catch (e) { if (mounted.current) setError(reason(e, w.name)); }
  };
  useEffect(() => {
    mounted.current = true;
    if (!started.current) { started.current = true; go(); } // once, also under React's dev double effect
    return () => { mounted.current = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="wconn" id="walConnecting">
      <div className={'wring' + (error ? ' bad' : '')}><WalletLogo w={w} /></div>
      <h3 id="dlgTitle">{error ? 'Not connected' : 'Approve in ' + w.name}</h3>
      <p id="walMsg">{error || `Open ${w.name} and approve the connection. Connecting shares your public address only. Every transaction still asks for your approval.`}</p>
      {error && <button className="btn" type="button" id="walRetry" onClick={go}>Try again</button>}
      <button className="btn ghost" type="button" onClick={onBack}>{error ? 'Choose another wallet' : 'Back'}</button>
    </div>
  );
}

/// The header button's wallet mark (null for the deposit address and the Sandbox).
export function ConnectedLogo() {
  const wallet = useSession((s) => s.wallet);
  return wallet ? <WalletLogo w={wallet} className="wlogo xs" /> : null;
}
export const connectedWallet = () => session.get().wallet;
