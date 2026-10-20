'use client';
// Portfolio: the private balance, the Veyl address, deposits waiting for approval, Phase 1 notes that can move in, the backup
// reminder, (Sandbox) the demo wallet, and every position and limit order with its totals.
import { Icon, TokenLogo, Tip } from '@/components/ui/primitives';
import { copyText } from '@/components/overlay';
import { runAction } from '@/features/actions/runAction';
import { openBackup, openRestore } from '@/features/backup/BackupDialogs';
import { FaucetButton, openStartOver, topUp, openStart, notConnected } from '@/features/session/AccountDialogs';
import { engine, isLive, useSession } from '@/features/session/session';
import { balanceOf } from '@/lib/veyl/services/balances';
import { age, short, tiny } from '@/lib/format';
import type { LegacyNote, PendingDeposit, VeylEngine } from '@/lib/veyl/types';
import { go } from '@/features/shell/router';
import { OrderRow, PortfolioSummary, PositionCard } from '@/features/positions/PositionCards';
import { usePositions, visiblePositions } from '@/features/positions/positions';
import { Skeleton } from '@/components/ui/primitives';
import { useBalances } from './balances';
import { useChainQuery } from '@/features/session/query';
import { openDeposit, openSend, openReceive } from './MoneyDialogs';

export default function PortfolioPage() {
  const live = useSession((s) => isLive(s));
  return (
    <section className="page" id="pg-home">
      <div className="ph"><div><h1>Portfolio</h1><p>Only you can see this. On-chain, none of it points to you.</p></div></div>
      <div className="pfgrid">
        <div className="col">
          <PositionsColumn live={live} />
        </div>
        <div className="col">
          {live ? <LiveColumn /> : <PreviewColumn />}
        </div>
      </div>
    </section>
  );
}

function PreviewColumn() {
  return (
    <div className="card shield" id="shieldCard">
      <div className="k"><span>Private balance</span><span className="pill priv"><Icon name="lock" />Hidden on-chain</span></div>
      <div className="toks" id="balList"><p className="dim" style={{ margin: 0, fontSize: 14 }}>Connect a wallet to see your private balance.</p></div>
      <div className="acts">
        <button className="btn" type="button" onClick={notConnected}><Icon name="down" size="sm" />Deposit</button>
        <button className="btn ghost" type="button" onClick={notConnected}><Icon name="up" size="sm" />Withdraw</button>
      </div>
    </div>
  );
}

function LiveColumn() {
  const account = useSession((s) => s.account);
  useSession((s) => s.version); // backedUpAt lives in the engine's store
  const backedUp = !!engine().store.data.backedUpAt;
  return (
    <>
      {account && <WalletCard />}
      <PrivateBalanceCard />
      <div className={'banner' + (backedUp ? '' : ' warn')} id="bkBanner">
        <Icon name="key" />
        <div><b>Back up your keys</b>Your private balance can only be opened from this browser. Clear it without a backup and the funds are gone.<br />
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" type="button" data-backup="export" onClick={openBackup}>Back up</button>
            <button className="btn ghost" type="button" data-backup="import" onClick={openRestore}>Restore</button>
          </span>
        </div>
      </div>
      <PendingNotes />
    </>
  );
}

function PrivateBalanceCard() {
  const { b, loading } = useBalances();
  const account = useSession((s) => s.account), sbx = useSession((s) => s.rt?.mode === 'sandbox');
  useSession((s) => s.version); // the Veyl address and shield error are read from the engine
  const E = engine();
  const held = Object.keys(E.tokens).filter((k) => balanceOf(b, 'priv', k) > 1e-12);
  const addr = E.veylAddress();
  const empty = E.shieldError ? 'Could not read the shielded pool: ' + E.shieldError
    : account ? 'Nothing shielded yet. ' + (sbx ? 'Top up from your wallet card.' : 'Deposit to start, or share your Veyl address to be paid privately.')
      : 'Nothing shielded yet. Share your Veyl address to be paid privately, or connect a wallet to deposit.';
  return (
    <div className="card shield" id="shieldCard">
      <div className="k"><span>Private balance<Tip term="privateBalance" align="l" /></span><span className="pill priv"><Icon name="lock" />Hidden on-chain</span></div>
      <div className="toks" id="balList">
        {loading && !held.length ? <p className="dim" style={{ margin: 0, fontSize: 14 }}>Reading your private balance from the chain. The first time on a device this can take a minute.</p> : held.length
          ? held.map((k) => <div key={k}><TokenLogo sym={k} /><b className="sens">{tiny(balanceOf(b, 'priv', k))}</b><span>{k}</span></div>)
          : <p className="dim" style={{ margin: 0, fontSize: 14 }}>{empty}</p>}
      </div>
      <div className="vaddr" id="veylAddr">
        <div className="mid"><small>Your Veyl address · paid here, nobody sees the amount or that it was you<Tip term="veylAddress" align="l" /></small><code className="sens">{addr}</code></div>
        <div className="vbtns">
          <button className="btn sm ghost" type="button" data-copy={addr} onClick={() => copyText(addr, 'Address copied')}>Copy</button>
          <button className="btn sm ghost" type="button" data-open="receive" title="QR code and payment link" onClick={openReceive}><Icon name="qr" size="sm" />Receive</button>
        </div>
      </div>
      <div className="acts">
        <button className="btn" type="button" data-open="deposit" onClick={() => (account ? openDeposit() : openStart())}><Icon name="down" size="sm" />Deposit</button>
        <button className="btn ghost" type="button" data-open="withdraw" onClick={() => openSend()}><Icon name="up" size="sm" />Withdraw</button>
      </div>
    </div>
  );
}

/// The public side: the wallet or the deposit address (the demo wallet in the Sandbox), with what it holds.
function WalletCard() {
  const { b, loadingPub } = useBalances();
  const account = useSession((s) => s.account) || '', isLocal = useSession((s) => s.isLocal);
  const sbx = useSession((s) => s.rt?.mode === 'sandbox'), faucet = useSession((s) => s.faucet);
  const all = Object.keys(engine().tokens);
  // the Sandbox shows its five tokens; on a chain, only what this address holds (there can be dozens of tokens)
  const shown = sbx ? all : all.filter((k) => balanceOf(b, 'pub', k) > 0);
  return (
    <div className="card pad wallet-card" id="pubCard">
      <div className="k" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <b style={{ fontWeight: 500 }}>{isLocal ? 'Deposit address' : 'Wallet'}</b><span className="pill flat"><Icon name="wallet" />Public · {short(account)}</span>
      </div>
      <div className="toks" id="pubToks">
        {!sbx && <NativeSol />}
        {shown.map((k) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}><TokenLogo sym={k} /><b className="sens" style={{ fontWeight: 500 }}>{tiny(balanceOf(b, 'pub', k))}</b><span className="dim">{k}{k === 'SOL' && solIsTestToken() ? ' (test)' : ''}</span></div>
        ))}
        {sbx && !shown.length && <p className="dim" style={{ margin: 0, fontSize: 14 }}>{loadingPub ? 'Reading balances…' : 'No tokens yet.'}</p>}
      </div>
      <div className="quick" style={{ marginTop: 12 }}>
        {sbx ? <><button type="button" onClick={topUp}>Top up</button><button type="button" onClick={openStartOver}>Start over</button></>
          : <><button type="button" onClick={openDeposit}>Deposit to private</button>{faucet && <FaucetButton className="" />}</>}
      </div>
    </div>
  );
}

const NATIVE_SOL = 'So11111111111111111111111111111111111111112';
const NATIVE_MS = 15_000;
/// Devnet deployments use a test mint for SOL in their pools; the wallet's own SOL is then a separate, real balance.
const solIsTestToken = () => engine().tokens.SOL?.mint !== NATIVE_SOL;
/// The address's native SOL, always first on the wallet card. Where the pools' SOL is that same native SOL, its row already
/// counts it (wrapped + native), so this one stays out.
function NativeSol() {
  const account = useSession((s) => s.account);
  const r = useChainQuery(['solBalance'], account ? () => engine().solBalance() : null, { initial: 0n, intervalMs: NATIVE_MS, account: true });
  if (!solIsTestToken()) return null;
  return <div id="nativeSol" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><TokenLogo sym="SOL" /><b className="sens" style={{ fontWeight: 500 }}>{tiny(Number(r.data) / 1e9)}</b><span className="dim">SOL</span></div>;
}

// ---------------------------------------------------------------- deposits waiting for approval, Phase 1 notes
/// A private action's kind (the relayer's request kinds), in plain words.
const ACTION_NAMES: Record<string, string> = {
  transact: 'a private send', shieldSwap: 'a private swap', shieldLp: 'a liquidity change', shieldOrder: 'a limit order', shieldOrderWithdraw: 'an order withdrawal',
  sealedSwap: 'a sealed swap', sealedClaim: 'a sealed swap claim', migrate: 'a note moving in',
};
const actionName = (k: string | null) => (k && ACTION_NAMES[k]) || 'a private action';
const symOfMint = (E: VeylEngine, mint: string) => Object.keys(E.tokens).find((k) => E.tokens[k].mint === String(mint));

function takeBack(d: PendingDeposit) {
  runAction({
    title: 'Taking a deposit back', kind: 'wallet', exec: (E) => E.cancelDeposit(d),
    done: (tx) => ({ title: 'Taken back', body: 'The deposit went back to your wallet. Nothing entered the shielded pool.', tx, activity: { t: 'Deposit taken back', s: 'Before approval', amt: '' } }),
  });
}
function moveIn(n: LegacyNote, E: VeylEngine) {
  runAction({
    title: 'Moving a note into the shielded pool', kind: 'proof', exec: (X) => X.migrate(n),
    done: (r) => ({ title: 'Moved in', tx: r.tx, body: 'The note is now a shielded note. Its amount was already public; from here on what you do with it is not.',
      activity: { t: 'Moved into the shielded pool', s: 'Legacy note · one proof', amt: `${tiny(E.fmt(n.sym, BigInt(n.value)))} ${n.sym}` } }),
  });
}

function PendingNotes() {
  useSession((s) => s.version);
  useBalances(); // the private sync that finds pending deposits is what refreshes this list
  const sbx = useSession((s) => s.rt?.mode === 'sandbox');
  const E = engine();
  const pending = (E.shieldPendingNow || []).map((d) => ({ d, sym: symOfMint(E, d.mint) })).filter((x): x is { d: PendingDeposit; sym: string } => !!x.sym);
  const legacy = E.legacyNotes();
  // notes this device planned for its own actions and hasn't seen on chain yet (the note-delivery outbox)
  const outbox = (E.outboxState?.() || []).filter((o) => !o.adopted);
  return (
    <>
      <div className="sec" id="noteH" hidden={!pending.length && !legacy.length && !outbox.length}><h2>Pending<Tip term="pending" align="l" /></h2></div>
      <div className="list" id="noteList">
        {pending.map(({ d, sym }) => (
          <div key={d.pending} className="row">
            <div className="mid"><b className="sens">{tiny(E.fmt(sym, BigInt(d.amount)))} {sym}</b>
              <small>{sbx ? 'Deposit waiting for the approved-set publisher (a few seconds)' : 'Deposit waiting for the approved-set publisher · yours to take back until then'}</small></div>
            <div className="rt"><span className="pill warn">Pending</span>
              {!sbx && <div style={{ marginTop: 6 }}><button className="btn sm ghost" type="button" data-cancel={d.pending} onClick={() => takeBack(d)}>Take back</button></div>}</div>
          </div>
        ))}
        {outbox.map((o) => (
          <div key={o.commitment} className="row" data-outbox={o.commitment}>
            <div className="mid"><b>{o.failed ? `Not sent: ${actionName(o.kind)}` : `On its way: ${actionName(o.kind)}`}<Tip term="outbox" align="l" /></b>
              <small>{o.failed ? 'The relayer didn\'t accept it, so nothing left your balance. This line clears itself.' : `Started ${age(Date.now() - o.at)} ago · waiting to show up on Solana`}</small></div>
            <div className="rt"><span className={'pill ' + (o.failed ? 'flat' : 'warn')}>{o.failed ? 'Not sent' : 'On its way'}</span></div>
          </div>
        ))}
        {legacy.map((n) => (
          <div key={n.precommitment || n.commitment} className="row">
            <div className="mid"><b className="sens">{tiny(E.fmt(n.sym, BigInt(n.value)))} {n.sym}</b><small>Phase 1 note · leaf {n.index} · its amount was public</small></div>
            <div className="rt"><span className="pill flat">Legacy</span>
              <div style={{ marginTop: 6 }}><button className="btn sm ghost" type="button" onClick={() => moveIn(n, E)}>Move in</button></div></div>
          </div>
        ))}
      </div>
    </>
  );
}

const ORDERS_SHOWN = 20;
function PositionsColumn({ live }: { live: boolean }) {
  const { d, loading } = usePositions();
  const account = useSession((s) => s.account);
  const list = live ? visiblePositions(d) : [];
  const orders = live ? d.orders.slice(0, ORDERS_SHOWN) : [];
  const skeleton = <div className="card pad"><Skeleton width="40%" /><Skeleton width="70%" style={{ marginTop: 10 }} /></div>;
  return (
    <>
      {live && <PortfolioSummary list={list} d={d} />}
      <div className="sec"><h2>Positions<Tip term="positions" align="l" /></h2><button type="button" onClick={() => go('pools')}>New position</button></div>
      <div className="list" id="posList">
        {!live ? <div className="card empty"><b>No positions</b>Nothing here yet.</div>
          : loading && !d.positions.length ? skeleton
            : list.length ? list.map((q) => <PositionCard key={q.id} q={q} d={d} />)
              : <div className="card empty"><b>No positions yet</b>{account ? 'Open a pool and add liquidity, privately or from your wallet.' : 'Connect a wallet. Private positions made on this device show here too.'}</div>}
      </div>
      <div className="sec"><h2>Limit orders<Tip term="partFilled" align="l" /></h2></div>
      <div className="list" id="ordList">
        {orders.length ? orders.map((o) => <OrderRow key={o.id} o={o} d={d} />) : <div className="card empty">{live ? 'No limit orders.' : 'No orders.'}</div>}
      </div>
    </>
  );
}
