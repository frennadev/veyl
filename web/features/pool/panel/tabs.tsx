'use client';
// The panel's four tabs. Each is a hook that returns its form and a TabModel (details, who sees what, what blocks it, the
// button, the action), so the panel renders every tab's footer the same way. A new tab is a new hook in TABS. The panel
// mounts one tab component at a time (keyed by tab), so each hook keeps its own fixed set of React hooks.
import { tl } from '@/features/pools/label';
import { useEffect, type ReactNode } from 'react';
import { Hint, Icon, Segmented, TokenLogo, Tip } from '@/components/ui/primitives';
import { SealBox, mmss, msLeft, sealedOpen, type SealedRead } from '@/features/sealed/sealed';
import { runAction } from '@/features/actions/runAction';
import { tiny } from '@/lib/format';
import { useAsyncQuery } from '@/features/session/query';
import {
  PRIVATE_MAX_BINS, SHAPE_LABEL, binIds, distribution, engineShape, rangeFromBins, simPlan, type Side,
} from '@/lib/veyl/services/liquidity';
import { quoteFees, type PoolView } from '@/lib/veyl/services/pools';
import type { Mode, SdkPort, VeylEngine } from '@/lib/veyl/types';
import { priceInput, type PoolMath } from '../poolMath';
import { clearAmounts, panel, setPanel, type PanelState, type Tab } from '../state';
import { AmountBox, ShapeRange, Simulator, maxText, type Detail, type SeenText } from './parts';

export interface PanelCtx {
  pool: PoolView; m: PoolMath | null; E: VeylEngine | null; sdk: SdkPort | null; mode: Mode; s: PanelState;
  priv: boolean; block: string; bal: (sym: string) => number; balText: (sym: string) => string; usdY: number | null; ivSecs: number;
  sealed: SealedRead;
}
/// `hint` replaces the panel's default hint under the button.
export interface TabModel { body: ReactNode; details: Detail[]; seen: SeenText; blocker: string; label: ReactNode; run: () => void; hint?: ReactNode }

const kindOf = (priv: boolean): 'proof' | 'wallet' => (priv ? 'proof' : 'wallet');
const whereOf = (priv: boolean) => (priv ? 'Private' : 'Public');
const over = (v: number, have: number) => v > have + 1e-12;
const lockLabel = (priv: boolean, privText: string, pubText: string) => (priv ? <><Icon name="lock" size="sm" />{privText}</> : pubText);
const networkFee = (priv: boolean, flat = 'Relayer, a flat fee') => priv ? flat : '≈ 0.00001 SOL';
const PUBLIC_SEEN = (pub: string): SeenText => ({ hidden: 'Nothing.', pub });
/// The swap's fees as detail rows, when the engine's quote reports them: the pool's LP fee and Veyl's protocol fee.
const feeRows = (f: { lp: number; protocol: number } | null | undefined, sym: string): Detail[] =>
  f ? [['Pool fee', `${tiny(f.lp)} ${sym}`, 'feeTier'], ['Protocol fee', `${tiny(f.protocol)} ${sym}`, 'protocolFee']] : [];

// ---------------------------------------------------------------- add
function useAdd(c: PanelCtx): TabModel {
  const { pool: p, m, s, priv } = c;
  const a = m?.st.active ?? 0, lo = a + s.lo, hi = a + s.hi, n = hi - lo + 1;
  const ax = s.side === 'y' ? 0 : parseFloat(s.amtX) || 0, ay = s.side === 'x' ? 0 : parseFloat(s.amtY) || 0;
  const ids = binIds(lo, hi);
  const dist = m && c.sdk ? distribution(c.sdk, ids, a, s.shape, s.side, m.price(a), ax, ay) : null;
  const plan = m && c.sdk ? simPlan(c.sdk, ids, a, s.shape, s.side, m.price, ax, ay, c.usdY) : null;
  const setSide = (side: Side) => panel.set((x) => ({ side, ...rangeFromBins(x.hi - x.lo + 1, side) }));
  const short = over(ax, c.bal(p.x)) ? p.x : over(ay, c.bal(p.y)) ? p.y : null;
  const blocker = c.block || (!m ? 'Reading the pool…' : !(ax > 0 || ay > 0) ? 'Enter an amount'
    : short ? `Not enough ${short}${priv ? ' in your shielded balance' : ' in your wallet'}`
      : priv && n > PRIVATE_MAX_BINS ? `Narrow the range to ${PRIVATE_MAX_BINS} bins`
        : (lo > a && ax === 0) || (hi < a && ay === 0) ? `This range takes only ${lo > a ? p.x : p.y}` : '');
  const details: Detail[] = [['Bins', <>{n}{n > PRIVATE_MAX_BINS && priv && <> <span className="down">(max {PRIVATE_MAX_BINS} private)</span></>}</>]];
  if (m) details.push(['Value', `${tiny(ax * m.price(a) + ay)} ${tl(p.y)}`]);
  if (!priv) details.push(['Rent', '≈ 0.049 SOL per 60-bin share account', 'rent']);
  details.push(['Network fee', networkFee(priv, 'Relayer, a flat fee per proof (quoted when you confirm)'), 'networkFee']);
  return {
    body: <>
      <div className="list" id="tab-add" style={{ gap: 12 }}>
        <div className="lbl"><span>Tokens to add<Tip term="side" align="l" /></span></div>
        <Segmented id="sideSeg" dataKey="side" label="Tokens to add" value={s.side} onChange={setSide}
          options={[{ value: 'both', label: 'Both tokens' }, { value: 'x', label: 'Only ' + tl(p.x), id: 'sideX' }, { value: 'y', label: 'Only ' + tl(p.y), id: 'sideY' }]} />
        <AmountBox ids={{ box: 'boxX', input: 'amtX', tk: 'tkX', left: 'hintX', bal: 'balX', max: 'maxX' }} label="Amount of the first token" sym={p.x} hidden={s.side === 'y'}
          value={s.amtX} onChange={(amtX) => setPanel({ amtX })} left={m && hi < a ? 'Not used below the price' : ''} balance={c.balText(p.x)} onMax={() => setPanel({ amtX: maxText(c.bal(p.x)) })} />
        <AmountBox ids={{ box: 'boxY', input: 'amtY', tk: 'tkY', left: 'hintY', bal: 'balY', max: 'maxY' }} label="Amount of the second token" sym={p.y} hidden={s.side === 'x'}
          value={s.amtY} onChange={(amtY) => setPanel({ amtY })} left={m && lo > a ? 'Not used above the price' : ''} balance={c.balText(p.y)} onMax={() => setPanel({ amtY: maxText(c.bal(p.y)) })} />
      </div>
      <ShapeRange m={m} stats={p.stats} binStep={p.bs} dist={dist}><Simulator plan={plan} m={m} stats={p.stats} usdY={c.usdY} ivSecs={c.ivSecs} /></ShapeRange>
    </>,
    details, blocker,
    label: lockLabel(priv, 'Add privately', 'Add from wallet'),
    seen: priv
      ? { hidden: 'Your wallet, your balances, how large your position is (the shielded pool holds every shielded position together; your share is a note only you can read).', pub: 'This add: its bins and the amounts and shares it puts in (the pool\'s reserves move), the relayer\'s flat fee.' }
      : PUBLIC_SEEN('Your wallet, the bins and amounts, and every later claim and withdrawal.'),
    run: () => {
      const shape = s.shape;
      runAction({
        title: 'Adding liquidity', kind: kindOf(priv),
        exec: (E) => E.addLiquidity(p, { priv, amountX: ax, amountY: ay, lo, hi, shape: engineShape(shape) }),
        done: (pos) => { clearAmounts(); return {
          title: 'Position added', tx: pos.tx,
          body: priv ? `Your ${tl(p.x)}–${tl(p.y)} position is live inside the shielded aggregate. On-chain: this action's change per bin, not whose it is or how large your position is. Back up your keys.` : `Your ${tl(p.x)}–${tl(p.y)} position is live, owned by your wallet.`,
          activity: { t: `Added liquidity · ${tl(p.x)}–${tl(p.y)}`, s: `${whereOf(priv)} · ${pos.ids.length} bins · ${SHAPE_LABEL[shape]}`, amt: [ax ? `${tiny(ax)} ${tl(p.x)}` : '', ay ? `${tiny(ay)} ${tl(p.y)}` : ''].filter(Boolean).join(' + ') },
        }; },
      });
    },
  };
}

// ---------------------------------------------------------------- zap
const ZAP_MAX_BINS = 16;
function useZap(c: PanelCtx): TabModel {
  const { pool: p, m, s, priv, E } = c;
  const sym = s.zapX ? p.x : p.y, other = s.zapX ? p.y : p.x, v = parseFloat(s.zapAmt) || 0;
  const a = m?.st.active ?? 0, lo = a + s.lo, hi = a + s.hi, n = hi - lo + 1;
  const dist = m && c.sdk ? distribution(c.sdk, binIds(lo, hi), a, s.shape, s.side, m.price(a), 0, 0) : null;
  const prev = useAsyncQuery('zapPreview', E && m && v > 0 ? () => E.planZapPreview(p, { xIn: s.zapX, amount: v, lo, hi, shape: engineShape(s.shape) }) : null,
    [p.id, s.zapX, v, lo, hi, s.shape], 350);
  const prevText = prev.value ? `${tiny(prev.value.swapIn)} ${sym} → ${tiny(prev.value.swapOut)} ${other}` : '';
  const blocker = c.block || (!m ? 'Reading the pool…' : !(v > 0) ? 'Enter an amount' : over(v, c.bal(sym)) ? 'Not enough ' + sym
    : n > ZAP_MAX_BINS ? `Narrow the range to ${ZAP_MAX_BINS} bins` : '');
  return {
    body: <>
      <div className="list" id="tab-zap" style={{ gap: 12 }}>
        <p className="hint"><Icon name="bolt" /><span>One token in. Part of it is swapped inside this pool, the rest goes into your bins, in one transaction.<Tip term="zap" align="r" /></span></p>
        <Segmented id="zapSeg" dataKey="z" label="Token to zap in" value={s.zapX ? 'x' : 'y'} onChange={(z) => setPanel({ zapX: z === 'x', zapAmt: '' })}
          options={[{ value: 'x', label: tl(p.x) + ' in', id: 'zapX' }, { value: 'y', label: tl(p.y) + ' in', id: 'zapY' }]} />
        <AmountBox ids={{ input: 'zapAmt', tk: 'zapTk', left: 'zapPrev', bal: 'zapBal', max: 'zapMax' }} label="Amount to zap in" sym={sym}
          value={s.zapAmt} onChange={(zapAmt) => setPanel({ zapAmt })} left={prevText && '≈ ' + prevText} balance={c.balText(sym)} onMax={() => setPanel({ zapAmt: maxText(c.bal(sym)) })} />
      </div>
      <ShapeRange m={m} stats={p.stats} binStep={p.bs} dist={dist} />
    </>,
    details: [['Bins', String(n), 'bins'], ['Swap inside the pool', prevText || '—'], ['Network fee', networkFee(priv), 'networkFee']],
    blocker, label: lockLabel(priv, 'Zap in privately', 'Zap in from wallet'),
    seen: priv ? { hidden: 'Your wallet, your balance, your position\'s total size.', pub: 'The amount zapped, the internal swap, the shares added per bin.' } : PUBLIC_SEEN('Your wallet, the amount, the swap and the bins.'),
    run: () => runAction({
      title: 'Zapping in', kind: kindOf(priv),
      exec: (X) => X.zap(p, { priv, xIn: s.zapX, amount: v, lo, hi, shape: engineShape(s.shape) }),
      done: (pos) => { clearAmounts(); return {
        title: 'Zapped in', tx: pos.tx,
        body: `One ${sym} payment became a ${tl(p.x)}–${tl(p.y)} position across ${pos.ids.length} bins${priv ? ', held in the shielded aggregate (its size is hidden).' : '.'}`,
        activity: { t: `Zapped into ${tl(p.x)}–${tl(p.y)}`, s: `${whereOf(priv)} · ${pos.ids.length} bins`, amt: `${tiny(v)} ${sym}` },
      }; },
    }),
  };
}

// ---------------------------------------------------------------- limit order
const ORDER_OFFSET = 3; // the default price: three bins below (buy) or above (sell) the active bin
function useLimit(c: PanelCtx): TabModel {
  const { pool: p, m, s, priv } = c;
  const buy = s.buy, sym = buy ? p.y : p.x;
  const active = m?.st.active;
  useEffect(() => { if (m && active != null && !panel.get().ordPrice) setPanel({ ordPrice: priceInput(m.price(active + (buy ? -ORDER_OFFSET : ORDER_OFFSET))) }); }, [m, active, buy]);
  const px = parseFloat(s.ordPrice), v = parseFloat(s.ordAmt) || 0;
  const bin = m && px > 0 ? m.binFor(px) : null;
  const wrong = m && bin != null && (buy ? bin >= m.st.active : bin <= m.st.active);
  const blocker = c.block || (!m ? 'Reading the pool…' : bin == null ? 'Enter a price' : wrong ? (buy ? 'A buy sits below the price' : 'A sell sits above the price')
    : !(v > 0) ? 'Enter an amount' : over(v, c.bal(sym)) ? 'Not enough ' + sym : '');
  const binNote = bin == null || !m ? (m ? 'Enter a price' : '—')
    : `Bin ${bin} · exact price ${tiny(m.price(bin))} ${tl(p.y)} · ${bin - m.st.active > 0 ? '+' : ''}${bin - m.st.active} bins from the price`;
  return {
    body: (
      <div className="list" id="tab-limit" style={{ gap: 12 }}>
        <Segmented id="ordSeg" dataKey="o" label="Order side" value={buy ? 'buy' : 'sell'} onChange={(o) => setPanel({ buy: o === 'buy', ordPrice: '', ordAmt: '' })}
          options={[{ value: 'buy', label: 'Buy ' + tl(p.x), id: 'ordBuy' }, { value: 'sell', label: 'Sell ' + tl(p.x), id: 'ordSell' }]} />
        <div className="fld">
          <label htmlFor="ordPrice" id="ordPriceL">{buy ? 'Buy' : 'Sell'} {tl(p.x)} at ({tl(p.y)} per {tl(p.x)})<Tip term="limitOrder" align="r" /></label>
          <input id="ordPrice" type="text" inputMode="decimal" autoComplete="off" value={s.ordPrice} onChange={(e) => setPanel({ ordPrice: e.target.value.replace(/[^0-9.]/g, '') })} />
          <small id="ordBin">{binNote}</small>
        </div>
        <AmountBox ids={{ input: 'ordAmt', tk: 'ordTk', left: 'ordGet', bal: 'ordBal', max: 'ordMax' }} label="Order amount" sym={sym}
          value={s.ordAmt} onChange={(ordAmt) => setPanel({ ordAmt })} balance={c.balText(sym)} onMax={() => setPanel({ ordAmt: maxText(c.bal(sym)) })}
          left={bin != null && v > 0 && m ? `Fills to ≈ ${tiny(buy ? v / m.price(bin) : v * m.price(bin))} ${buy ? p.x : p.y}` : ''} />
        <p className="hint"><Icon name="clock" /><span>An order sits in one bin. Swaps that cross it fill it at that bin&apos;s price; it earns its share of that bin&apos;s fee. Withdraw any time, filled or not.</span></p>
      </div>
    ),
    details: [['Network fee', networkFee(priv), 'networkFee']], blocker,
    label: <>{priv && <Icon name="lock" size="sm" />}{buy ? 'Place buy order' : 'Place sell order'}{priv ? ' privately' : ''}</>,
    seen: priv ? { hidden: 'Your wallet and your balance. The order\'s shares come back as a note only you can spend.', pub: 'The bin, the side and the amount (an order sits in the pool).' } : PUBLIC_SEEN('Your wallet, the bin, the side and the amount.'),
    run: () => {
      const b = bin!, at = tiny(m!.price(b));
      runAction({
        title: 'Placing a limit order', kind: kindOf(priv),
        exec: (E) => E.placeOrder(p, { priv, isAsk: !buy, binId: b, amount: v }),
        done: (o) => { clearAmounts(); return {
          title: 'Order placed', tx: o.tx, body: `${buy ? 'Buy ' : 'Sell '}${tl(p.x)} at ${at} ${tl(p.y)}. It fills as swaps cross bin ${b}.`,
          activity: { t: `${buy ? 'Buy ' : 'Sell '}${tl(p.x)} order placed`, s: `${whereOf(priv)} · at ${at} ${tl(p.y)}`, amt: `${tiny(v)} ${sym}` },
        }; },
      });
    },
  };
}

// ---------------------------------------------------------------- swap: instant, or sealed into the pool's batch
const SLIPPAGE = '1%';
const DEFAULT_PROOF_S = 20;
function useSwap(c: PanelCtx): TabModel {
  const { pool: p, s, priv, E } = c;
  const a = s.swapX ? p.x : p.y, b = s.swapX ? p.y : p.x, v = parseFloat(s.swapIn) || 0;
  const ss = c.sealed.st, sealedHere = !!ss?.enabled, sealed = sealedOpen(ss) && (s.swMode || 'sealed') === 'sealed';
  const q = useAsyncQuery('routeQuote', E && v > 0 ? async () => { const best = await E.quoteRoute(a, b, E.unit(a, v)); return best ? { out: E.fmt(b, best.out), route: best.path.map((h) => h.name).join(' → '), fees: quoteFees(E, a, best) } : { out: null, route: '' }; } : null,
    [a, b, v], 250);
  const quote = q.value && q.key === JSON.stringify([a, b, v]) ? q.value : null;
  const bt = c.balText(a);
  const setMode = (m: 'sealed' | 'instant') => setPanel(m === 'sealed' ? { swMode: m, src: 'priv' } : { swMode: m });
  const body = (
    <div className="list" id="tab-swap" style={{ gap: 8 }}>
      {sealedHere && <div className="lbl"><span>Swap mode<Tip term="sealedMode" align="l" /></span></div>}
      <div className="seg full mode" id="swMode" role="group" aria-label="Swap mode" hidden={!sealedHere}>
        <button type="button" data-m="sealed" aria-pressed={sealed} onClick={() => setMode('sealed')}><b><Icon name="lock" size="sm" />Sealed</b><small>Size hidden · settles with its batch</small></button>
        <button type="button" data-m="instant" aria-pressed={!sealed} onClick={() => setMode('instant')}><b>Instant</b><small>Now · the amount is public at the pool</small></button>
      </div>
      {sealed && <SealBox pool={p} read={c.sealed} />}
      <div className="amt"><div className="b"><span>You pay</span><span className="sens" id="pswBal">{bt ? 'Balance ' + bt : ''}</span></div>
        <div className="m"><input id="pswIn" type="text" inputMode="decimal" placeholder="0" autoComplete="off" aria-label="Amount to pay" value={s.swapIn} onChange={(e) => setPanel({ swapIn: e.target.value.replace(/[^0-9.]/g, '') })} /><Tk sym={a} id="pswTkIn" /></div></div>
      <button className="flip" type="button" id="pswFlip" aria-label="Switch direction" onClick={() => setPanel({ swapX: !s.swapX, swapIn: '' })}><Icon name="swap" /></button>
      <div className="amt"><div className="b"><span>You receive</span><span id="pswRoute">{quote?.route ? (sealed ? 'at today\'s price' : 'via ' + quote.route) : ''}</span></div>
        <div className="m"><input id="pswOut" type="text" readOnly tabIndex={-1} aria-label="Amount you receive" value={quote?.out != null ? (sealed ? '≈ ' : '') + tiny(quote.out) : ''} /><Tk sym={b} id="pswTkOut" /></div></div>
    </div>
  );
  if (sealed && ss.batch) {
    const batch = ss.batch, dir = s.swapX ? 0 : 1, min = E ? E.fmt(a, BigInt(ss.minIn?.[dir] || '0')) : 0, open = batch.state === 'open';
    const blocker = c.block || (!priv ? 'Sealed swaps spend your shielded balance' : !(v > 0) ? 'Enter an amount' : over(v, c.bal(a)) ? `Not enough ${a} in your shielded balance`
      : v < min ? `The smallest sealed swap here is ${tiny(min)} ${a}` : !open ? `Batch ${batch.seq} is sealing; the next one opens in a moment` : '');
    const proofS = E?.proveMs?.swap?.length ? Math.round(E.proveMs.swap[E.proveMs.swap.length - 1] / 1000) : DEFAULT_PROOF_S;
    return {
      body, blocker, label: <><Icon name="lock" size="sm" />Seal into batch {batch.seq}</>,
      details: [['Batch', `${batch.seq} · ${open ? 'closes in ' + mmss(msLeft(ss, c.sealed.at)) : 'sealing'}`], ['Price', 'the batch\'s clearing price', 'clearingPrice'], ['Smallest swap', `${tiny(min)} ${a}`, 'minSealed'], ['Network fee', `Relayer, a flat fee in ${a} now and in ${b} when you claim`, 'networkFee']],
      seen: { hidden: 'Your wallet, your balance and this swap\'s size: it is encrypted on this device to the batch committee, which only ever decrypts the batch\'s total.', pub: `That a ${a} to ${b} swap joined batch ${batch.seq}. When it settles: the batch's totals per side, its clearing price and how many sold on each side. The relayer's flat fee.` },
      hint: <Hint id="actHint" icon="lock">The proof is made on this device (about {proofS} s). After the batch settles, claim your output here: a second proof, a new hidden note.</Hint>,
      run: () => runAction({
        title: 'Sealing your swap', kind: 'proof', exec: (X) => X.sealedSwap(p, { xIn: s.swapX, amount: v }),
        done: (r) => { clearAmounts(); return {
          title: 'Sealed into batch ' + r.seq, tx: r.tx,
          body: `Your ${a} left your shielded balance as an encrypted amount. Nobody, the relayer included, can see it. When the batch settles, claim your ${b} on this page.`,
          activity: { t: `Sealed swap ${a} → ${b}`, s: `Batch ${r.seq} · size hidden`, amt: `${tiny(v)} ${a}` },
        }; },
      }),
    };
  }
  const blocker = c.block || (!(v > 0) ? 'Enter an amount' : over(v, c.bal(a)) ? 'Not enough ' + a : !quote ? 'Quoting…' : quote.out == null ? 'No route with liquidity' : '');
  return {
    body, blocker,
    details: [['Rate', quote?.out ? `1 ${a} = ${tiny(quote.out / v)} ${b}` : '—'], ...feeRows(quote?.fees, a), ['Slippage limit', SLIPPAGE, 'slippage'], ['Network fee', networkFee(priv), 'networkFee']],
    label: lockLabel(priv, sealedHere ? 'Swap now, amount public' : 'Swap privately', 'Swap from wallet'),
    seen: priv ? { hidden: 'Your wallet and your balance. The output lands in a note only you can spend.', pub: 'The route and the amounts in and out (they meet the pool), the relayer\'s flat fee.' } : PUBLIC_SEEN('Your wallet and the whole swap.'),
    run: () => runAction({
      title: 'Swapping', kind: kindOf(priv),
      exec: (X) => (priv ? X.swap(a, b, v) : X.swapPublic(a, b, v)),
      done: (r) => { clearAmounts(); const got = tiny(E!.fmt(b, r.out)); return {
        title: `Got ${got} ${b}`, tx: r.tx,
        body: priv ? 'Delivered as a new shielded note. The swap\'s amounts were public at the pool; who made it was not.' : 'Delivered to your wallet.',
        activity: { t: `Swapped ${a} → ${b}`, s: `${whereOf(priv)} · via ${r.route.join(' → ')}`, amt: `+${got} ${b}` },
      }; },
    }),
  };
}
const Tk = ({ sym, id }: { sym: string; id: string }) => <span className="tk" id={id}><TokenLogo sym={sym} className="" />{tl(sym)}</span>;

export const TABS: Record<Tab, { label: string; use: (c: PanelCtx) => TabModel }> = {
  add: { label: 'Add', use: useAdd }, zap: { label: 'Zap', use: useZap }, limit: { label: 'Limit', use: useLimit }, swap: { label: 'Swap', use: useSwap },
};
