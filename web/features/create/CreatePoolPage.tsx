'use client';
// Create a pool (open pool creation): two tokens, a fee tier from the program's list, an opening price, and a refundable
// bond. The engine checks each token against the safety rules (and says why it refuses one), finds an existing pool of the
// same pair and tier, orders the mints and handles decimals. Listed in the nav only when the engine can create pools.
import { useMemo, useState } from 'react';
import { ErrorLine, Field, Hint, Tip, TokenLogo } from '@/components/ui/primitives';
import { lookupMint, useRemoteToken } from '@/features/tokens/tokenData';
import { runAction } from '@/features/actions/runAction';
import { setFilter } from '@/features/pools/state';
import { usePoolConfigs } from '@/features/pools/usePoolViews';
import { engine, isLive, usdOf, useSession } from '@/features/session/session';
import { useAsyncQuery, useChainQuery } from '@/features/session/query';
import { go, openPool } from '@/features/shell/router';
import { cleanAmount, tiny, SOLANA_ADDRESS } from '@/lib/format';
import type { FeeTier, TokenCheck } from '@/lib/veyl/types';

const CATEGORY_LABEL: Record<string, string> = { stable: 'Stablecoins', major: 'Major tokens', volatile: 'Volatile tokens' };
const pctOf = (pips: number) => (pips / 1e4).toFixed(pips < 1000 ? 2 : 2).replace(/\.?0+$/, '') + '%';

/// A token field: a mint address typed in, or one of Veyl's listed tokens picked from the list.
function TokenField({ id, label, mint, onMint, check }: { id: string; label: string; mint: string; onMint: (m: string) => void; check: TokenCheck | null }) {
  const listed = Object.entries(engine().tokens);
  return (
    <div className="fld">
      <label htmlFor={id}>{label}<Tip term="tokenRules" align="l" /></label>
      <input id={id} type="text" placeholder="Token mint address" autoComplete="off" spellCheck={false} value={mint} onChange={(e) => onMint(e.target.value.trim())} />
      <div className="quick">{listed.slice(0, 6).map(([sym, t]) => <button key={sym} type="button" onClick={() => onMint(t.mint)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><TokenLogo sym={sym} size={16} className="" />{sym}</button>)}</div>
      <TokenPreview mint={mint} check={check} />
      <small id={id + 'Check'}>
        {!mint ? 'Paste a mint, or pick a listed token.' : !SOLANA_ADDRESS.test(mint) ? 'That is not a Solana address.'
          : !check ? 'Checking the token…' : check.ok ? `${check.info?.symbol || 'Token'} · ${check.info?.name || ''} · ${check.info?.decimals} decimals${check.info?.listed ? ' · listed on Veyl' : ''}`
            : <span className="err" style={{ display: 'inline' }}>{check.reasons.map((r) => r.text).join(' ')}{!check.info && <JupiterElsewhere mint={mint} />}</span>}
      </small>
    </div>
  );
}

/// For a mint that isn't a token on this network: what Jupiter (mainnet) calls it, so a pasted mainnet mint makes sense.
function JupiterElsewhere({ mint }: { mint: string }) {
  const mainnet = useSession((s) => (s.rt?.cfg as { cluster?: string } | null | undefined)?.cluster === 'mainnet');
  const r = useAsyncQuery('jupiterToken', !mainnet && SOLANA_ADDRESS.test(mint) ? () => lookupMint(mint) : null, [mint], 250).value;
  return r ? <> Jupiter lists it on mainnet as {r.symbol || r.name}.</> : null;
}

/// What the pasted token is: Jupiter's logo, name and symbol (through our relayer), its Jupiter verified flag (labelled as
/// Jupiter's, not Veyl's), and the engine's own read of the mint. Listed tokens show their logo from the preloaded set.
function TokenPreview({ mint, check }: { mint: string; check: TokenCheck | null }) {
  const listedSym = useMemo(() => Object.keys(engine().tokens).find((k) => engine().tokens[k].mint === mint), [mint]);
  const remote = useAsyncQuery('jupiterToken', SOLANA_ADDRESS.test(mint) && !listedSym ? () => lookupMint(mint) : null, [mint], 250).value;
  const listedRemote = useRemoteToken(listedSym || null);
  const r = listedSym ? listedRemote : remote;
  if (!SOLANA_ADDRESS.test(mint) || (!r && !check?.info)) return null;
  // the engine read the mint and it isn't a token on this network: Jupiter's card (mainnet data) would contradict that,
  // so the field's message says it instead
  if (check && !check.info) return null;
  const symbol = check?.info?.symbol || r?.symbol || '', name = check?.info?.name || r?.name || '';
  return (
    <div className="row" id="tokPreview" style={{ padding: '10px 12px', alignItems: 'center' }}>
      <TokenLogo sym={listedSym || mint} size={36} className="" />
      <div className="mid"><b>{symbol || 'Unknown token'}</b><small>{name}{r ? '' : ' · not in Jupiter\'s token list'}</small></div>
      <div className="rt">{r?.verified ? <span className="pill good" title="Jupiter's verified flag, not Veyl's">Verified by Jupiter</span> : r ? <span className="pill flat">Not verified by Jupiter</span> : null}</div>
    </div>
  );
}

export default function CreatePoolPage() {
  const live = useSession((s) => isLive(s)), account = useSession((s) => s.account);
  const protocolFeeBps = useSession((s) => s.rt?.protocolFeeBps ?? null);
  const [mintA, setMintA] = useState(''), [mintB, setMintB] = useState('');
  const [tierId, setTierId] = useState<number | null>(null), [price, setPrice] = useState(''), [err, setErr] = useState('');
  const E = live ? engine() : null;

  const tierRead = useChainQuery<FeeTier[]>(['feeTiers'], E?.listTiers ? () => E.listTiers!() : null, { initial: [], staleMs: 5 * 60_000, persist: true });
  const tiers = tierRead.data, unavailable = !!tierRead.error && !tiers.length; // e.g. an engine newer than the deployment
  const terms = useChainQuery(['bondTerms'], E?.bondTerms ? () => E.bondTerms!() : null, { initial: null as { amount: bigint; lockDays: number } | null, staleMs: 5 * 60_000, persist: true }).data;
  const valid = (m: string) => SOLANA_ADDRESS.test(m);
  const checkA = useAsyncQuery('checkToken', E?.checkToken && valid(mintA) ? () => E.checkToken!(mintA) : null, [mintA], 300).value;
  const checkB = useAsyncQuery('checkToken', E?.checkToken && valid(mintB) ? () => E.checkToken!(mintB) : null, [mintB], 300).value;
  const bothOk = !!(checkA?.ok && checkB?.ok) && mintA !== mintB;
  const existing = useAsyncQuery('poolFor', E?.poolFor && bothOk && tierId != null ? () => E.poolFor!(mintA, mintB, tierId) : null, [mintA, mintB, tierId], 200).value;
  const pools = usePoolConfigs();
  const existingId = existing ? pools.find((p) => p.address === existing)?.id : null;

  const symA = checkA?.info?.symbol, symB = checkB?.info?.symbol;
  const market = useMemo(() => { const ua = symA ? usdOf(symA) : null, ub = symB ? usdOf(symB) : null; return ua && ub ? ua / ub : null; }, [symA, symB]);
  const tier = tiers.find((t) => t.id === tierId) || null;
  const p = cleanAmount(price).value;
  const blocker = unavailable ? 'Not available on this deployment yet' : !live ? 'Not connected' : !account ? 'Connect a wallet' : !valid(mintA) || !valid(mintB) ? 'Choose two tokens' : mintA === mintB ? 'Choose two different tokens'
    : !checkA || !checkB ? 'Checking the tokens…' : !bothOk ? 'A token can\'t be used' : tierId == null ? 'Choose a fee tier' : existing ? 'This pool already exists' : !(p > 0) ? 'Set the opening price' : '';

  const create = () => {
    setErr('');
    const o = { mintA, mintB, tierId: tierId!, price: p }, pair = `${symA}–${symB}`;
    runAction({
      title: 'Creating the pool', kind: 'wallet', exec: (X) => X.createPool!(o),
      done: (r) => { setFilter({ q: r.address, status: 'all' }); setTimeout(() => go('pools'), 0); return {
        title: `${pair} pool created`, tx: r.tx,
        body: `Your pool is live at ${tier ? pctOf(tier.feePips) : ''} and shows as Unverified until your bond is released. It needs liquidity before anyone can trade in it: open it from Pools and add some.`,
        activity: { t: `Pool created · ${pair}`, s: tier ? `${pctOf(tier.feePips)} tier · bond paid` : 'Bond paid', amt: terms ? `−${Number(terms.amount) / 1e9} SOL bond` : '' },
      }; },
    });
  };

  const byCategory = tiers.reduce<Record<string, FeeTier[]>>((acc, t) => { (acc[t.category || 'other'] ||= []).push(t); return acc; }, {});
  return (
    <section className="page" id="pg-create">
      <div className="narrow page" style={{ padding: 0 }}>
        <div className="ph"><div><h1>Create a pool</h1><p>Any two safe tokens, at a fee tier you pick. Your pool shows as unverified until your bond is released.</p></div></div>
        <div className="card pad list" style={{ gap: 14 }}>
          <TokenField id="cpA" label="First token" mint={mintA} onMint={setMintA} check={checkA} />
          <TokenField id="cpB" label="Second token (the price is quoted in it)" mint={mintB} onMint={setMintB} check={checkB} />
          <div className="lbl"><span>Fee tier<Tip term="feeTier" align="l" /></span><span className="dim">fixed for the pool&apos;s life</span></div>
          {Object.entries(byCategory).map(([cat, list]) => (
            <div key={cat}>
              <small className="dim">{CATEGORY_LABEL[cat] || 'Other'}</small>
              <div className="seg full" role="group" aria-label={'Fee tiers for ' + (CATEGORY_LABEL[cat] || cat)} style={{ flexWrap: 'wrap', marginTop: 6 }}>
                {list.map((t) => <button key={t.id} type="button" data-tier={t.id} aria-pressed={tierId === t.id} onClick={() => setTierId(t.id)}>{pctOf(t.feePips)} <small>bin {(t.binStep / 100).toFixed(2)}%</small></button>)}
              </div>
            </div>
          ))}
          {!tiers.length && (unavailable
            ? <Hint icon="alert" tone="warn">Pool creation isn&apos;t available on this deployment yet: its fee tiers can&apos;t be read. Try again after the next update.</Hint>
            : <small className="dim">Reading the fee tiers…</small>)}
          {existing && <Hint icon="alert" tone="warn">A {symA}–{symB} pool at this tier already exists. {existingId ? <button className="btn sm ghost" type="button" onClick={() => openPool(existingId)}>Open it</button> : 'Pick another tier to create a second pool of this pair.'}</Hint>}
          <Field id="cpPrice" label={<>Opening price{symA && symB ? ` (${symB} per ${symA})` : ''}<Tip term="openingPrice" align="l" /></>}
            hint={market ? <>Market: {tiny(market)} <button className="btn sm ghost" type="button" onClick={() => setPrice(String(+market.toPrecision(6)))}>Use it</button></> : 'Set it close to the market price.'}>
            <input id="cpPrice" type="text" inputMode="decimal" placeholder="0" autoComplete="off" value={price} onChange={(e) => setPrice(cleanAmount(e.target.value).text)} />
          </Field>
          <dl className="det">
            <div><dt>Bond<Tip term="bond" align="l" /></dt><dd>{terms ? `${Number(terms.amount) / 1e9} SOL, refundable after ${terms.lockDays} days` : 'A refundable SOL deposit, returned after the lock period'}</dd></div>
            {tier && <div><dt>Traders pay<Tip term="traderCost" align="l" /></dt><dd>{pctOf(tier.feePips)} + volatility fee{protocolFeeBps != null ? ` + ${(protocolFeeBps / 100).toFixed(2)}% protocol` : ''}</dd></div>}
            <div><dt>Network fee</dt><dd>Paid from your wallet (public)</dd></div>
          </dl>
          <Hint icon="alert" tone="warn">Creating a pool is public: your wallet pays the bond and appears as the creator. Liquidity added to it later can be private.</Hint>
          <ErrorLine id="cpErr">{err}</ErrorLine>
          <button className="btn" type="button" id="cpGo" disabled={!!blocker} onClick={create}>{blocker || 'Create pool and pay the bond'}</button>
        </div>
      </div>
    </section>
  );
}
