'use client';
// The v2 app: boots the session (runtime scripts → engine), follows the hash, and lays out the frame around the current page.
// Exported as static HTML with the frame and a loading state; everything that needs the engine renders after it loads.
import { useCallback, useEffect, useState } from 'react';
import IconSprite from '@/components/IconSprite';
import { Modal, Toasts } from '@/components/overlay';
import { Skeleton } from '@/components/ui/primitives';
import { parsePayLink, takePayLink } from '@/features/portfolio/MoneyDialogs';
import { usePoolConfigs } from '@/features/pools/usePoolViews';
import { TokenDataSync } from '@/features/tokens/tokenData';
import { notConnected } from '@/features/session/AccountDialogs';
import { bootSession, useSession } from '@/features/session/session';
import { QueryProvider } from '@/features/session/query';
import { BottomNav, Header, Sidebar, StateBanner, useBodyClass, useEscape } from './Chrome';
import { CurrentPage } from './pages';
import { parseHash, route, useRoute } from './router';

/// Follows the hash once the session is ready: a page, a pool, or a payment link (which opens Send on the portfolio).
function useHashRouting(ready: boolean) {
  const configs = usePoolConfigs();
  useEffect(() => {
    if (!ready) return;
    const apply = () => {
      const pay = parsePayLink(location.hash);
      if (pay) {
        try { history.replaceState(null, '', location.pathname + location.search + '#portfolio'); } catch { /* sandboxed frame */ }
        route.set({ page: 'home', pool: null }); setTimeout(() => takePayLink(pay, notConnected), 60); return;
      }
      route.set(parseHash(location.hash, (id) => configs.some((c) => c.id === id)));
    };
    apply(); window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [ready, configs]);
}

export default function AppShell() {
  return <QueryProvider><Shell /></QueryProvider>;
}

function Shell() {
  const status = useSession((s) => s.status), error = useSession((s) => s.error), mode = useSession((s) => s.rt?.mode);
  const page = useRoute().page;
  const [drawer, setDrawer] = useState(false);
  const closeDrawer = useCallback(() => setDrawer(false), []);

  useEffect(() => { bootSession(); }, []);
  useHashRouting(status === 'ready');
  useEscape(drawer, closeDrawer);
  useBodyClass('on-pool', page === 'pool');
  useBodyClass('sbx', mode === 'sandbox');

  return (
    <>
      <Sidebar open={drawer} onClose={closeDrawer} />
      <div className="testnet-bar" role="status" hidden><b><i></i>Solana</b></div>
      <Header onMenu={() => setDrawer(true)} />
      <StateBanner />
      <Toasts />
      <main className="app">
        {status === 'ready' ? <CurrentPage />
          : status === 'error' ? <section className="page"><div className="card empty"><b>The app didn&apos;t start</b>{error}</div></section>
            : <section className="page" aria-busy="true"><div className="card pad"><Skeleton width="40%" /><Skeleton width="70%" style={{ marginTop: 10 }} /></div></section>}
      </main>
      <BottomNav />
      <Modal />
      <IconSprite />
      <TokenDataSync />
    </>
  );
}
