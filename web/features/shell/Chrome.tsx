'use client';
// The frame around every page: sidebar (collapsible on desktop, a drawer on phones), header, the state banner under it, and
// the bottom bar on phones. Same classes and ids as the legacy page, so app.css lays it out unchanged.
import { useEffect, useState } from 'react';
import { Icon, Banner } from '@/components/ui/primitives';
import { closeModal, isModalOpen } from '@/components/overlay';
import { storage } from '@/lib/storage';
import { checkRpc, setHide, useSession } from '@/features/session/session';
import { openStart } from '@/features/session/AccountDialogs';
import { AccountButton, ModeChip } from './AccountMenu';
import { Kpis } from './Kpis';
import { PrivacyChip } from '@/features/privacy/PrivacyPage';
import { BAR_ORDER, PAGES, available, navKey, pageDef } from './pages';
import { go, useRoute, type PageId } from './router';

/// Toggles a class on <body> (app.css keys layout off body classes: side-c, hide, on-pool, sbx).
export function useBodyClass(name: string, on: boolean) {
  useEffect(() => { document.body.classList.toggle(name, on); return () => document.body.classList.remove(name); }, [name, on]);
}

function NavButton({ id, withIcon, label, onGo }: { id: PageId; withIcon: boolean; label?: boolean; onGo?: () => void }) {
  const r = useRoute(); const d = pageDef(id);
  return (
    <button type="button" data-go={id} title={withIcon && label ? d.title : undefined} aria-current={navKey(r.page) === id ? 'page' : undefined} onClick={() => { closeModal(); go(id); onGo?.(); }}>
      {withIcon && <Icon name={d.icon} />}{label ? <span>{d.title}</span> : d.title}
    </button>
  );
}

const Logo = () => <a className="logo" href="index.html" aria-label="Veyl home"><img className="full" src="brand/veyl-lockup.svg" alt="Veyl" /><img className="mk" src="brand/veyl-mark-small.svg" alt="Veyl" /></a>;

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rt = useSession((s) => s.rt);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(storage.get('veyl:side', matchMedia('(max-width:1199px)').matches) === true); }, []);
  useBodyClass('side-c', collapsed);
  const toggle = () => { setCollapsed(!collapsed); storage.set('veyl:side', !collapsed); };
  return (
    <>
      <aside className={'side' + (open ? ' open' : '')} id="side" aria-label="App">
        <div className="side-top"><Logo /><button className="ib side-x" id="sideClose" type="button" aria-label="Close menu" onClick={onClose}><Icon name="x" size="sm" /></button></div>
        <nav className="side-nav" aria-label="Sections">
          {PAGES.filter((p) => p.nav.side && available(p, rt)).map((p) => <NavButton key={p.id} id={p.id} withIcon label onGo={onClose} />)}
          <p className="sg"></p>
          <a href="docs.html" title="Docs"><Icon name="book" /><span>Docs</span></a>
        </nav>
        <button className="side-col" id="sideCol" type="button" aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} aria-expanded={!collapsed} onClick={toggle}>
          <Icon name="back" size="sm" /><span>Collapse</span>
        </button>
      </aside>
      <div className={'side-bg' + (open ? ' open' : '')} id="sideBg" onClick={onClose}></div>
    </>
  );
}

export function Header({ onMenu }: { onMenu: () => void }) {
  const hide = useSession((s) => s.hide);
  useBodyClass('hide', hide);
  return (
    <header className="hdr">
      <div className="app">
        <button className="ib menu" id="menuBtn" type="button" aria-label="Open the menu" aria-controls="side" onClick={onMenu}><Icon name="menu" /></button>
        <Logo />
        <nav className="topnav" aria-label="App">{BAR_ORDER.map((id) => <NavButton key={id} id={id} withIcon={false} />)}</nav>
        <Kpis />
        <div className="hdr-r">
          <NetLabel />
          <ModeChip />
          <PrivacyChip />
          <button className="ib" id="hideBtn" type="button" aria-pressed={hide} aria-label={hide ? 'Show balances' : 'Hide balances'} onClick={() => setHide(!hide)}><Icon name={hide ? 'eyeoff' : 'eye'} /></button>
          <AccountButton />
        </div>
      </div>
    </header>
  );
}

/// The chain's name (kept hidden: the mode chip shows it), marked bad while its RPC doesn't answer.
function NetLabel() {
  const chain = useSession((s) => s.rt?.chainName || 'Solana'), down = useSession((s) => s.rpc === 'down');
  return <span className={'net' + (down ? ' bad' : '')} id="netLbl" hidden><i></i>{chain}</span>;
}

/// Under the header: the chain isn't answering, or nobody is connected yet. Nothing in the Sandbox or preview.
export function StateBanner() {
  const chain = useSession((x) => (x.rt?.mode === 'chain' ? x.rt.chainName : null));
  const rpc = useSession((x) => x.rpc), account = useSession((x) => x.account);
  let body = null;
  if (chain) {
    if (rpc === 'down') body = <Banner icon="alert" tone="bad" title={`${chain} is not answering`}>The RPC in this site&apos;s configuration did not respond. Nothing can be read or sent until it does.<br /><button className="btn ghost" type="button" id="retryRpc" onClick={checkRpc}>Try again</button></Banner>;
    else if (!account) body = <Banner icon="key" title="No wallet needed">Fund a deposit address from any wallet or exchange, or connect a wallet. Either way, everything after the deposit is private.<br /><button className="btn" type="button" id="bannerConnect" onClick={openStart}>Get started</button></Banner>;
  }
  return <div className="statebar" id="stateBanner" hidden={!body}>{body}</div>;
}

export function BottomNav() {
  return <nav className="bnav" aria-label="App"><div className="in">{BAR_ORDER.map((id) => <NavButton key={id} id={id} withIcon />)}</div></nav>;
}

/// Escape closes the topmost thing: the dialog, else the phone drawer.
export function useEscape(drawerOpen: boolean, closeDrawer: () => void) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; if (isModalOpen()) closeModal(); else if (drawerOpen) closeDrawer(); };
    document.addEventListener('keydown', f); return () => document.removeEventListener('keydown', f);
  }, [drawerOpen, closeDrawer]);
}
