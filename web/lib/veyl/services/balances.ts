// Balances per token: private (the shielded notes on this device, rebuilt from the chain) and public (the connected wallet or
// the deposit address). Human units. A token that can't be read is left out, never shown as zero by mistake.
// The two load separately: public balances are a few cheap reads (in parallel, well under a second); the private side syncs
// the shielded pool first, which on a fresh device scans the whole tree and can take a minute.
import type { BalancesPort, Sym, UnitsPort, WalletPort } from '../types';

export type BalanceMap = Record<Sym, number>;
export interface Balances { priv: BalanceMap; pub: BalanceMap }
export const EMPTY_BALANCES: Balances = { priv: {}, pub: {} };

export async function loadPublicBalances(E: BalancesPort & UnitsPort & WalletPort): Promise<BalanceMap> {
  if (!E.account) return {};
  const out: BalanceMap = {};
  await Promise.all(Object.keys(E.tokens).map(async (sym) => { try { out[sym] = E.fmt(sym, await E.publicBalance(sym)); } catch { /* unreadable */ } }));
  return out;
}

export async function loadPrivateBalances(E: BalancesPort & UnitsPort): Promise<BalanceMap> {
  try { await E.refreshNotes(); } catch { /* the relayer or RPC is down: the notes already on this device still count */ }
  const out: BalanceMap = {};
  for (const sym of Object.keys(E.tokens)) { try { out[sym] = E.fmt(sym, E.privateBalance(sym)); } catch { /* unreadable */ } }
  return out;
}

export const balanceOf = (b: Balances, src: keyof Balances, sym: Sym): number => b[src][sym] || 0;
/// Enough to cover `v` (with float slack)?
export const covers = (have: number, v: number) => v <= have + 1e-12;

/// The balance text beside an amount field: the source's balance, and, paying privately with an empty private balance,
/// what the wallet holds (so a funded wallet never reads as zero). '' when nothing can be read.
export function balanceLabel(b: Balances, src: keyof Balances, sym: Sym, live: boolean, connected: boolean, fmt: (v: number) => string = String): string {
  if (!live || (src === 'pub' && !connected)) return '';
  const own = b[src][sym] || 0, wallet = b.pub[sym] || 0;
  const text = `${fmt(own)} ${sym}`;
  return src === 'priv' && own <= 0 && wallet > 0 ? `${text} · wallet ${fmt(wallet)}` : text;
}
