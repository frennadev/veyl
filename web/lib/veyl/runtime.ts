// The single bridge between v2 and the browser engine. Loads the deployment config and the engine bundle (the same files, in
// the same order, as the legacy /app), then builds the engine for the mode. Nothing else in web/ reads window.Veyl or the
// VEYL_* globals: everything above this file sees the ports in ./types.
import type { ChainEngine, MarketPort, MarketSources, MarketsPort, RuntimeConfig, Runtime, SandboxEngine, SdkPort, WalletDirectory, WalletProvider } from './types';
import { requestedMode } from './mode';

/// Runtime files, in load order. veyl.config.js and sandbox.config.js are written by build-site; the engine needs snarkjs.
export const RUNTIME_SCRIPTS = ['veyl.config.js', 'sandbox.config.js', 'veyl.keys.js', 'snarkjs.min.js', 'qrcode.js', 'veyl-sol.js'];

interface VeylGlobal {
  Engine: (new (cfg: RuntimeConfig) => ChainEngine) & { PROTOCOL_FEE_BPS?: number; walletList?(): WalletProvider[]; onWallets?(cb: () => void): () => void };
  Sandbox?: new (opts: object) => SandboxEngine & { cfg: RuntimeConfig };
  SDK?: SdkPort;
  Markets?: new (o: { keys: object }) => MarketsPort;
  MARKET_SOURCES?: MarketSources;
  Market?: new () => MarketPort;
}
type Globals = Window & { Veyl?: VeylGlobal; VEYL_CONFIG?: RuntimeConfig | null; VEYL_SANDBOX?: object; VEYL_KEYS?: object };

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src; s.async = false;
    s.onload = () => resolve(); s.onerror = () => reject(new Error('Could not load ' + src));
    document.body.appendChild(s);
  });
}

let booting: Promise<Runtime> | null = null;
/// Loads once per page; later calls (React's dev double effects, several consumers) share the same promise.
export function loadRuntime(): Promise<Runtime> {
  return (booting ??= (async () => {
    // async=false scripts execute in insertion order, so a missing optional file doesn't stop the ones after it
    const results = await Promise.allSettled(RUNTIME_SCRIPTS.map(loadScript));
    if (results[RUNTIME_SCRIPTS.indexOf('veyl-sol.js')].status === 'rejected') throw new Error('The app engine did not load. Reload the page.');
    return createRuntime(window as Globals, requestedMode(location.search));
  })());
}

/// Picks the engine: the Sandbox when asked for (and present), the deployment when its config names programs, else preview.
function createRuntime(w: Globals, want: 'sandbox' | 'chain'): Runtime {
  const V = w.Veyl, cfg = w.VEYL_CONFIG || null, deployed = !!cfg?.programs, sdk = V?.SDK || null;
  const protocolFeeBps = typeof V?.Engine?.PROTOCOL_FEE_BPS === 'number' ? V.Engine.PROTOCOL_FEE_BPS : null;
  const markets = V?.Markets && V.MARKET_SOURCES ? { api: new V.Markets({ keys: w.VEYL_KEYS || {} }), sources: V.MARKET_SOURCES } : null;
  const E = V?.Engine;
  const wallets: WalletDirectory | null = E?.walletList && E.onWallets ? { list: () => E.walletList!(), on: (cb) => E.onWallets!(cb) } : null;
  if (want === 'sandbox' && V?.Sandbox) {
    const engine = new V.Sandbox({ ...(w.VEYL_SANDBOX || {}) });
    return { mode: 'sandbox', engine, cfg: engine.cfg, chainName: 'the demo', deployed, sdk, protocolFeeBps, markets, market: engine.market, wallets: null };
  }
  if (cfg?.programs && V?.Engine) {
    const engine = new V.Engine(cfg);
    return { mode: 'chain', engine, cfg, chainName: cfg.chainName || 'Solana', deployed, sdk, protocolFeeBps, markets, market: engine.market, wallets };
  }
  // no deployment: a standalone market feed still gives the header its SOL price
  const market = V?.Market ? new V.Market() : null;
  return { mode: 'preview', engine: null, cfg: null, chainName: 'Solana', deployed, sdk, protocolFeeBps, markets, market, wallets };
}
