'use client';
// Balances, read once for the whole page (header, portfolio, every dialog) through two account-specific queries: public
// (wallet / deposit address, fast) and private (the shielded pool, after its sync), so the fast figures never wait for the
// slow ones. Never persisted.
import { useMemo } from 'react';
import { loadPrivateBalances, loadPublicBalances, type BalanceMap, type Balances } from '@/lib/veyl/services/balances';
import { engine, useSession } from '@/features/session/session';
import { fullKey, queryClient, useChainQuery } from '@/features/session/query';

const PUBLIC_MS = 15_000, PRIVATE_MS = 30_000;
const NONE: BalanceMap = {};
const PUB = ['balances', 'public'], PRIV = ['balances', 'private'];

/// `loading`: the private balance is still syncing. `loadingPub`: the wallet / deposit address balances.
export function useBalances(): { b: Balances; loading: boolean; loadingPub: boolean } {
  const live = useSession((s) => !!s.rt?.engine && s.rpc !== 'down');
  const pub = useChainQuery(PUB, live ? () => loadPublicBalances(engine()) : null, { initial: NONE, intervalMs: PUBLIC_MS, account: true });
  const priv = useChainQuery(PRIV, live ? () => loadPrivateBalances(engine()) : null, { initial: NONE, intervalMs: PRIVATE_MS, account: true });
  const b = useMemo(() => ({ priv: priv.data, pub: pub.data }), [priv.data, pub.data]);
  return { b, loading: priv.loading, loadingPub: pub.loading };
}
/// For code outside React: the balances last read.
export const currentBalances = (): Balances => ({
  pub: queryClient.getQueryData<BalanceMap>(fullKey(PUB, true)) ?? NONE, priv: queryClient.getQueryData<BalanceMap>(fullKey(PRIV, true)) ?? NONE,
});
/// Re-reads only the public balances (cheap), e.g. while waiting for a transfer to arrive.
export const refreshPublicBalances = () => { queryClient.invalidateQueries({ queryKey: fullKey(PUB, true) }, { cancelRefetch: false }); };
