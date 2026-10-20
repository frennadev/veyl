// The Solana wallets the connect dialog suggests when they aren't installed, and logos for wallets that inject a global
// without one (Wallet Standard wallets bring their own icon). Logos from web3icons, bundled: nothing is fetched.
import { __iconNode as Phantom } from '@web3icons/react/icons/wallets/WalletPhantom';
import { __iconNode as Solflare } from '@web3icons/react/icons/wallets/WalletSolflare';
import { __iconNode as Backpack } from '@web3icons/react/icons/wallets/WalletBackpack';
import { iconUrl } from './web3icon';

export interface KnownWallet {
  name: string; icon: () => string; site: string;
  /// Opens this page inside the wallet's own browser (phones without an extension).
  browse?: (url: string) => string;
}
const cache: Record<string, string> = {};
const once = (k: string, f: () => string) => () => (cache[k] ??= f());
const ref = (url: string) => encodeURIComponent(new URL(url).origin);
export const KNOWN_WALLETS: KnownWallet[] = [
  { name: 'Phantom', icon: once('Phantom', () => iconUrl(Phantom)), site: 'https://phantom.com',
    browse: (url) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${ref(url)}` },
  { name: 'Solflare', icon: once('Solflare', () => iconUrl(Solflare)), site: 'https://solflare.com',
    browse: (url) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${ref(url)}` },
  { name: 'Backpack', icon: once('Backpack', () => iconUrl(Backpack)), site: 'https://backpack.app' },
];
/// A wallet's logo: the one it registered with, else ours for a known name, else '' (the dialog draws a wallet glyph).
export const walletLogo = (w: { name: string; icon: string | null }) =>
  w.icon || KNOWN_WALLETS.find((k) => k.name.toLowerCase() === w.name.toLowerCase())?.icon() || '';
