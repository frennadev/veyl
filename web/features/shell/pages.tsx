'use client';
// Every page and where it shows in the navigation, as one list: a new page is one entry.
import type { ComponentType } from 'react';
import type { IconName } from '@/components/ui/primitives';
import PoolsPage from '@/features/pools/PoolsPage';
import PortfolioPage from '@/features/portfolio/PortfolioPage';
import PoolPage from '@/features/pool/PoolPage';
import SwapPage from '@/features/swap/SwapPage';
import SealedPage from '@/features/sealed/SealedPage';
import PrivacyPage from '@/features/privacy/PrivacyPage';
import ActivityPage from '@/features/activity/ActivityPage';
import MarketsPage from '@/features/markets/MarketsPage';
import CreatePoolPage from '@/features/create/CreatePoolPage';
import { useSession } from '@/features/session/session';
import type { Runtime } from '@/lib/veyl/types';
import { useRoute, type PageId } from './router';

export interface PageDef {
  id: PageId; title: string; icon: IconName;
  nav: { side?: boolean; top?: boolean; bottom?: boolean };
  component: ComponentType;
  /// Shown (in the nav, and reachable) only when this holds, e.g. a feature the engine may not have yet.
  when?: (rt: Runtime | null) => boolean;
}

/// In sidebar order. The pool page has no nav entry: it highlights Pools.
export const PAGES: PageDef[] = [
  { id: 'swap', title: 'Swap', icon: 'swap', nav: { side: true, top: true, bottom: true }, component: SwapPage },
  { id: 'pools', title: 'Pools', icon: 'bars', nav: { side: true, top: true, bottom: true }, component: PoolsPage },
  { id: 'sealed', title: 'Sealed swaps', icon: 'seal', nav: { side: true }, component: SealedPage },
  { id: 'create', title: 'Create pool', icon: 'bars', nav: { side: true }, component: CreatePoolPage, when: (rt) => !!rt?.engine?.createPool },
  { id: 'home', title: 'Portfolio', icon: 'wallet', nav: { side: true, top: true, bottom: true }, component: PortfolioPage },
  { id: 'privacy', title: 'Privacy', icon: 'shield', nav: { side: true, top: true, bottom: true }, component: PrivacyPage },
  { id: 'activity', title: 'Activity', icon: 'clock', nav: { side: true }, component: ActivityPage },
  { id: 'markets', title: 'Markets', icon: 'globe', nav: {}, component: MarketsPage },
  { id: 'pool', title: 'Pool', icon: 'bars', nav: {}, component: PoolPage },
];
/// Top bar and bottom bar order (Pools first).
export const BAR_ORDER: PageId[] = ['pools', 'swap', 'home', 'privacy'];
export const pageDef = (id: PageId) => PAGES.find((p) => p.id === id)!;
export const navKey = (id: PageId): PageId => (id === 'pool' ? 'pools' : id);

/// Pages available with this engine (a page whose `when` fails isn't listed and falls back to Pools).
export const available = (p: PageDef, rt: Runtime | null) => !p.when || p.when(rt);

export function CurrentPage() {
  const rt = useSession((s) => s.rt);
  const def = pageDef(useRoute().page);
  const C = available(def, rt) ? def.component : PoolsPage;
  return <C />;
}
