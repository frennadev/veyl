// The session: which engine runs (sandbox / chain / preview), who is connected, whether the chain answers, and a version
// number that every data hook watches (invalidate() after an action reloads balances, pools and positions everywhere).
// Commands live here, beside the state they change; components call them and read the state through useSession().
import { createStore, useStore } from '@/lib/store';
import { storage } from '@/lib/storage';
import { loadRuntime } from '@/lib/veyl/runtime';
import type { ActivityEntry, Runtime, VeylEngine, WalletProvider } from '@/lib/veyl/types';

export interface SessionState {
  status: 'loading' | 'ready' | 'error'; error: string | null; rt: Runtime | null;
  account: string | null; isLocal: boolean;
  wallet: { name: string; icon: string | null } | null; // the connected wallet (null for the deposit address and the Sandbox)
  rpc: 'none' | 'checking' | 'ok' | 'down';
  faucet: boolean;            // the relayer's devnet faucet answers
  relayer: boolean | null;    // the relayer answers (null: not checked yet)
  version: number;            // bumped by invalidate()
  tick: number;               // Sandbox: bumped (debounced) when its chain moves (bots trade, batches settle)
  busy: boolean;              // an action is running: polling pauses, the dialog can't close
  hide: boolean;              // balances blurred on screen
  activity: ActivityEntry[];  // this device's own log, newest first
}

export const session = createStore<SessionState>({
  status: 'loading', error: null, rt: null, account: null, isLocal: false, wallet: null, rpc: 'none', faucet: false, relayer: null, version: 0, tick: 0, busy: false, hide: false, activity: [],
});
export const useSession = <S,>(select: (s: SessionState) => S): S => useStore(session, select);

/// The engine, for code that only runs once the session is ready and not in preview.
export function engine(): VeylEngine {
  const rt = session.get().rt; if (!rt?.engine) throw new Error('This page is not connected to Solana.'); return rt.engine;
}
export const isLive = (s: SessionState = session.get()) => !!s.rt?.engine;
/// Dollars per token: the Sandbox's market-anchored value, else the live market (Pyth, then Jupiter). Null when unknown.
export function usdOf(sym: string): number | null {
  const rt = session.get().rt; if (!rt) return null;
  if (rt.mode === 'sandbox') return rt.engine.usdOf(sym);
  return rt.market?.usd(sym) ?? null;
}

export const invalidate = () => session.set((s) => ({ version: s.version + 1 }));
export const setBusy = (busy: boolean) => session.set({ busy });
export function setHide(hide: boolean) { session.set({ hide }); storage.set('veyl:hide', hide); }

const ACTIVITY_MAX = 300;
export function logActivity(a: Omit<ActivityEntry, 'ts'>) {
  const rt = session.get().rt; const activity = [{ ...a, ts: Date.now() }, ...session.get().activity].slice(0, ACTIVITY_MAX);
  session.set({ activity });
  if (rt?.engine) { rt.engine.store.data.activity = activity; rt.engine.store.save(); }
}

// ---------------------------------------------------------------- boot
let started = false;
export async function bootSession(): Promise<void> {
  if (started) return; started = true;
  session.set({ hide: storage.get('veyl:hide', false) });
  let rt: Runtime;
  try { rt = await loadRuntime(); } catch (e) { session.set({ status: 'error', error: (e as Error).message }); return; }
  session.set({ rt, status: 'ready', rpc: rt.mode === 'chain' ? 'checking' : rt.mode === 'sandbox' ? 'ok' : 'none',
    activity: rt.engine?.store.data.activity?.slice() || [] });
  if (rt.mode === 'sandbox') return bootSandbox(rt);
  if (rt.mode === 'chain') {
    const E = rt.engine;
    checkRelayer();
    E.onAccount((account) => { session.set(account ? { account } : { account: null, isLocal: false, wallet: null }); invalidate(); });
    if (E.store.data.useLocal && Array.isArray(E.store.data.depositKey)) { try { await connectLocal(); } catch { /* reconnect from the menu */ } }
    else E.reconnect().then((a) => { if (a) afterWallet(); }, () => {}); // waits for the wallet to register: not before the RPC check
    await checkRpc();
  }
}

async function bootSandbox(rt: Extract<Runtime, { mode: 'sandbox' }>) {
  const E = rt.engine; session.set({ account: E.account, relayer: true });
  await E.init(); E.start();
  invalidate(); // the demo chain is up: re-read what was read before it was (funding below takes seconds)
  const sb = E.store.data.sandbox || (E.store.data.sandbox = {});
  if (!sb.funded) {
    try { await E.faucet(); sb.funded = Date.now(); sb.seen ||= Date.now(); E.store.save(); logActivity({ t: 'Wallet funded', s: 'Demo funds', amt: '' }); } catch { /* top up later */ }
  }
  invalidate();
  window.addEventListener('pagehide', () => E.save());
  let pending: ReturnType<typeof setTimeout> | null = null;
  E.on((ev) => {
    if ((ev.type === 'swap' || ev.type === 'tx') && !pending) pending = setTimeout(() => { pending = null; if (!document.hidden) session.set((s) => ({ tick: s.tick + 1 })); }, 500);
  });
}

const RELAYER_RECHECK_MS = 30_000;
/// Whether the relayer answers (and offers the devnet faucet); rechecked every 30 s on a real chain.
function checkRelayer() {
  const rt = session.get().rt; if (rt?.mode !== 'chain') return;
  rt.engine.relayerInfo().then((i) => session.set({ faucet: !!i?.faucet, relayer: !!i?.address }), () => session.set({ faucet: false, relayer: false }));
  setTimeout(checkRelayer, RELAYER_RECHECK_MS);
}

export async function checkRpc(): Promise<void> {
  const rt = session.get().rt; if (rt?.mode !== 'chain') return;
  session.set({ rpc: 'checking' });
  try { await rt.engine.ping(); session.set({ rpc: 'ok' }); invalidate(); } catch { session.set({ rpc: 'down' }); }
}

// ---------------------------------------------------------------- connecting
const afterWallet = () => {
  const E = engine(), w = E.wallet; session.set({ account: E.account, isLocal: false, wallet: w ? { name: w.name, icon: w.icon } : null }); invalidate();
};
export async function connectWallet(w: WalletProvider): Promise<void> { await engine().connect(w); afterWallet(); }
/// Forget the wallet or deposit address on this page (the deposit address key and the notes stay in this browser).
export async function disconnect(): Promise<void> {
  await engine().disconnect(); session.set({ account: null, isLocal: false, wallet: null }); invalidate();
}
/// No-wallet mode: a deposit address kept in this browser (its key goes into the encrypted backup).
export async function connectLocal(): Promise<void> {
  const account = await engine().connectLocal(); session.set({ account, isLocal: true, wallet: null }); invalidate();
}
