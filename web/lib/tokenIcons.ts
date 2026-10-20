// Brand marks from web3icons (bundled icon data, so still nothing is fetched from a third party). Only symbols whose
// web3icons entry is the same token: MET (Metronome there, Meteora here), MASK, SI, DBR and OMNI share a ticker with a
// different project, so they keep the drawn mark. Wrapped assets show their underlying coin. Everything else (mock and
// long-tail mints, WISP) falls back to the drawn mark in tokens.ts.
import type { TIconVariants } from '@web3icons/common';
import { iconUrl } from './web3icon';
import { __iconNode as BTC } from '@web3icons/react/icons/tokens/TokenBTC';
import { __iconNode as DOGE } from '@web3icons/react/icons/tokens/TokenDOGE';
import { __iconNode as ETH } from '@web3icons/react/icons/tokens/TokenETH';
import { __iconNode as HYPE } from '@web3icons/react/icons/tokens/TokenHYPE';
import { __iconNode as INJ } from '@web3icons/react/icons/tokens/TokenINJ';
import { __iconNode as JUP } from '@web3icons/react/icons/tokens/TokenJUP';
import { __iconNode as NEAR } from '@web3icons/react/icons/tokens/TokenNEAR';
import { __iconNode as PEPE } from '@web3icons/react/icons/tokens/TokenPEPE';
import { __iconNode as PYTH } from '@web3icons/react/icons/tokens/TokenPYTH';
import { __iconNode as RAY } from '@web3icons/react/icons/tokens/TokenRAY';
import { __iconNode as SOL } from '@web3icons/react/icons/tokens/TokenSOL';
import { __iconNode as STRK } from '@web3icons/react/icons/tokens/TokenSTRK';
import { __iconNode as USDC } from '@web3icons/react/icons/tokens/TokenUSDC';
import { __iconNode as USDE } from '@web3icons/react/icons/tokens/TokenUSDE';
import { __iconNode as USDT } from '@web3icons/react/icons/tokens/TokenUSDT';
import { __iconNode as WBTC } from '@web3icons/react/icons/tokens/TokenWBTC';
import { __iconNode as XMR } from '@web3icons/react/icons/tokens/TokenXMR';
import { __iconNode as ZEC } from '@web3icons/react/icons/tokens/TokenZEC';

const ICONS: Record<string, TIconVariants> = {
  SOL, USDC, USDT, USDe: USDE, JUP, PYTH, RAY, HYPE, INJ, DOGE, PEPE, STRK, ZEC, WBTC,
  cbBTC: BTC, WETH: ETH, wNEAR: NEAR, wXMR: XMR,
};

/// The token's web3icons mark (brand colour background, white mark) as an SVG data URL, or '' when it has none.
export function brandLogo(sym: string): string {
  const v = ICONS[sym]; return v ? iconUrl(v) : '';
}
