// / (exported as index.html). Ported 1:1 from the old site/index.html: same ids, classes, text and links. Its behaviour (nav
// border, the hero "flow" canvas, the liquidity try-it card, scroll reveals) stays in site/home.js, loaded by <LegacyScripts>
// after hydration; React renders this markup once and never re-renders it, so home.js may change it freely.
import PageHead from '@/components/PageHead';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import LegacyScripts from '@/components/LegacyScripts';
import { asset } from '@/lib/assets';

const DESCRIPTION = 'Veyl is concentrated DLMM liquidity on Solana, private by default: choose your range and shape, earn dynamic fees, and keep your position to yourself.';
const OG_TITLE = 'Veyl: liquidity, without a name';
const OG_DESCRIPTION = 'Veyl is private liquidity on Solana: provide into DLMM price bins and swap from a shielded balance, without your wallet showing up.';

// The padlock that marks what each liquidity tool keeps private.
const Lock = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="3" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></svg>;

// [pool id, label, dot classes, bin step, base fee, type]
const POOLS: [string, string, [string, string], string, string, string][] = [
  ['sol-usdc', 'SOL–USDC', ['c-eth', 'c-usdc'], '0.10%', '0.05%', 'Volatile'],
  ['sol-usdt', 'SOL–USDT', ['c-eth', 'c-usde'], '0.10%', '0.05%', 'Volatile'],
  ['usdt-usdc', 'USDT–USDC', ['c-usde', 'c-usdc'], '0.01%', '0.01%', 'Stable'],
  ['jup-sol', 'JUP–SOL', ['c-jup', 'c-eth'], '0.20%', '0.20%', 'Volatile'],
  ['jup-usdc', 'JUP–USDC', ['c-jup', 'c-usdc'], '0.20%', '0.20%', 'Volatile'],
  ['bonk-sol', 'BONK–SOL', ['c-bonk', 'c-eth'], '0.50%', '0.50%', 'Memecoin'],
  ['bonk-usdc', 'BONK–USDC', ['c-bonk', 'c-usdc'], '0.50%', '0.50%', 'Memecoin'],
  ['wif-sol', 'WIF–SOL', ['c-wif', 'c-eth'], '0.50%', '0.50%', 'Memecoin'],
  ['wif-usdc', 'WIF–USDC', ['c-wif', 'c-usdc'], '0.50%', '0.50%', 'Memecoin'],
  ['jto-sol', 'JTO–SOL', ['c-jto', 'c-eth'], '0.20%', '0.20%', 'Volatile'],
  ['pyth-usdc', 'PYTH–USDC', ['c-pyth', 'c-usdc'], '0.20%', '0.20%', 'Volatile'],
  ['ray-sol', 'RAY–SOL', ['c-ray', 'c-eth'], '0.20%', '0.20%', 'Volatile'],
];

export default function Home() {
  return (
    <>
      <PageHead title="Veyl" description={DESCRIPTION} ogTitle={OG_TITLE} ogDescription={OG_DESCRIPTION} />
      <a className="skip" href="#main">Skip to content</a>
      <SiteNav links={[['#how', 'Liquidity'], ['#pools', 'Pools'], ['#privacy', 'Privacy'], ['docs.html', 'Docs']]} />

      <main id="main">
        <section className="hero">
          <div className="w">
            <div className="hero-grid">
              <div className="hero-copy">
                <p className="eyebrow"><span className="tag net"><i></i>Private liquidity · Solana</span></p>
                <h1>Concentrated liquidity,<br /><em>kept private.</em></h1>
                <p className="sub">Provide into price bins on Solana and earn fees that rise with the market. The pool sees the liquidity. Nobody sees whose it is, or how much.</p>
                <div className="btn-row">
                  <a className="btn primary lg" href="app.html#pools">Add liquidity</a>
                  <a className="btn ghost lg" href="#how">How it works</a>
                </div>
                <p className="nowallet"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.9-4.3-1.7-7.5-5.3-7.5-9.9V6z" /></svg>No wallet needed. Fund a deposit address from any wallet or exchange.</p>
              </div>

              <figure className="vflow" id="flow" aria-label="Deposits of different sizes pass through a proof and come out as identical pieces that fill the liquidity bins.">
                <canvas id="flowCv" aria-hidden="true"></canvas>
                <div className="flow-tags" aria-hidden="true"><span className="ft in" data-stage="0">Deposits</span><span className="ft gate" data-stage="1">Proof</span><span className="ft out" data-stage="2">Liquidity bins</span></div>
              </figure>
            </div>

            <div className="stages" id="stages">
              <div data-stage="0"><b>Deposit</b><h3>Your tokens go in</h3></div>
              <div data-stage="1"><b>Proof</b><h3>Made on your device</h3></div>
              <div data-stage="2"><b>Bins</b><h3>Earning fees, unlinked to you</h3></div>
            </div>
          </div>
        </section>

        <section id="how" className="sec feature tryit">
          <div className="w">
            <div className="fhead reveal"><span className="pk">How it works</span><h2>Pick a range.<br /><em>Earn privately.</em></h2><p>Liquidity sits in price bins. Choose a pool, a shape and how many bins around the price. Every swap through your bins pays you.</p></div>
            <div className="trygrid">
              <div className="trycard" id="lpCard" aria-live="polite">
                <div className="tc-h"><label className="poolsel"><span className="dots" id="lpDots"><i className="c-eth"></i><i className="c-usdc"></i></span><select id="lpPool" aria-label="Pool"><option value="sol-usdc">SOL–USDC</option><option value="sol-usdt">SOL–USDT</option><option value="usdt-usdc">USDT–USDC</option></select></label></div>
                <p className="tc-mk" id="lpMk">Bin step 0.10% · base fee 0.05%</p>
                <svg id="lpBins" className="tc-bins" role="img" aria-label="Liquidity in each price bin of the chosen pool; the bins you are about to fill are outlined, the ones you hold are lit"></svg>
                <div className="tc-ax"><span id="lpLo">lower prices</span><span id="lpMid">active bin</span><span id="lpHi">higher prices</span></div>
                <div className="lp-ctl">
                  <div className="lp-row"><span className="lbl">Shape</span><div className="seg" id="lpShape" role="group" aria-label="Liquidity shape"><button type="button" data-s="spot" aria-pressed="true">Spot</button><button type="button" data-s="curve" aria-pressed="false">Curve</button><button type="button" data-s="bidask" aria-pressed="false">Bid-Ask</button></div></div>
                  <div className="lp-row"><span className="lbl">Range</span><div className="seg" id="lpRange" role="group" aria-label="Bins around the price"><button type="button" data-w="2" aria-pressed="false">5 bins</button><button type="button" data-w="5" aria-pressed="true">11 bins</button><button type="button" data-w="7" aria-pressed="false">15 bins</button></div></div>
                </div>
                <p className="lp-prev" id="lpPrev"></p>
                <div className="lp-go">
                  <button className="btn primary lg" id="lpGo" type="button">See how it works</button>
                  <a className="btn quiet" href="app.html">Open the app</a>
                </div>
                <div className="tc-run" id="lpRun" hidden><div className="tc-bar"><i id="lpBar"></i></div><p id="lpMsg"></p></div>
              </div>
              <div className="tryside">
                <ol className="trysteps steps-line" id="lpSteps" data-state="idle"><i className="runner" aria-hidden="true"></i>
                  <li data-k="deposit"><b>Deposit</b><span>Tokens become private notes.</span></li>
                  <li data-k="prove"><b>Prove</b><span>Your browser proves you own them.</span></li>
                  <li data-k="verify"><b>Verified</b><span>The proof is checked.</span></li>
                  <li data-k="apply"><b>In the bins</b><span>The bins fill. Nobody sees whose.</span></li>
                  <li data-k="earn"><b>Earn</b><span>Swaps pay you. Claim privately.</span></li>
                </ol>
                <div className="tryseen" id="lpSeen"><div className="pb"><b>The chain sees</b><p>The pool, a change per bin, the relayer's flat fee, spent-note tags.</p></div><div className="hd"><b>It does not see</b><p>Whose position it is, how large, what you earned, or your wallet: it never signs.</p></div></div>
                <p className="trynote"><a href="docs.html#privacy">What is and isn't private</a></p>
              </div>
            </div>
          </div>
        </section>

        <section id="tools" className="sec feature">
          <div className="w">
            <div className="fhead reveal"><span className="pk">Liquidity tools</span><h2>Every LP tool.<br /><em>All of it private.</em></h2><p>The tools you'd expect from the best liquidity apps on Solana. Each one runs from your private balance, so none of it points back to your wallet.</p></div>
            <div className="privgrid lqgrid reveal">
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 19h18M5 19V9M9 19V6M13 19V6M17 19V9" /></svg></span><h3>Spot, Curve, Bid-Ask</h3><p>Spread evenly, stack it around the price, or weight the edges for a big move.</p><span className="pv-p"><Lock />Private: who owns it and how big</span></div>
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 17l5-5 4 3 8-8" /><path d="M15 7h5v5" /></svg></span><h3>Fees that move with the market</h3><p>Fees rise when the price moves fast, so you earn more when it matters. Never above 10%.</p><span className="pv-p"><Lock />Private: what you earn</span></div>
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 12h16" /><rect x="9" y="5" width="6" height="14" rx="1.5" /></svg></span><h3>Limit orders</h3><p>Park tokens in one bin. It fills when the price crosses, and earns fees while it waits.</p><span className="pv-p"><Lock />Private: whose order it is</span></div>
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M13 3L5 13h6l-1 8 8-10h-6z" /></svg></span><h3>Zap in</h3><p>Only hold one token? Zap swaps part of it and adds both sides in one step.</p><span className="pv-p"><Lock />Private: paid from your private balance</span></div>
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v5h-5" /></svg></span><h3>One-tap rebalance</h3><p>Price moved out of range? Re-centre your liquidity around it and keep your shape.</p><span className="pv-p"><Lock />Private: not linked to your earlier moves</span></div>
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 7v10M9.5 9.5h4a1.8 1.8 0 0 1 0 3.6h-3a1.8 1.8 0 0 0 0 3.6h4" /></svg></span><h3>Claim any time</h3><p>Fees build up in your position. Claim them, or take 25%, 50% or all of it out.</p><span className="pv-p"><Lock />Private: lands in your private balance</span></div>
            </div>
          </div>
        </section>

        <section id="pools" className="sec feature">
          <div className="w">
            <div className="fhead reveal"><span className="pk">Pools</span><h2>Deep pairs.<br /><em>Ready for your range.</em></h2><p>83 curated pools: every major Meteora pair, from SOL–USDC to the top memecoins and tokenized stocks, each listed by Veyl. Pick a pair, choose your range and start earning.</p></div>
            <div className="livepools reveal" id="livePools">
              <table className="tbl" aria-describedby="poolsNote">
                <thead><tr><th>Pool</th><th className="num">Bin step</th><th className="num">Base fee</th><th className="num">Type</th></tr></thead>
                <tbody id="poolRows">
                  {POOLS.map(([id, label, [a, b], step, fee, type]) => (
                    <tr key={id}><td><a className="pair" href={`app.html#pool-${id}`}><span className="dots"><i className={a}></i><i className={b}></i></span><span><b>{label}</b></span></a></td><td className="num">{step}</td><td className="num">{fee}</td><td className="num">{type}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="btn-row foot"><p className="small muted" id="poolsNote">The 12 deepest shown. 71 more in the app, including HYPE, TRUMP, cbBTC, PUMP, PENGU and JupSOL. Every pool is private; fees never go above 10%.</p><a className="btn primary" href="app.html#pools">See all 83 pools</a></div>
          </div>
        </section>

        <section id="privacy" className="sec feature">
          <div className="w">
            <div className="fhead reveal"><span className="pk">Privacy</span><h2>Your position.<br /><em>Nobody else's business.</em></h2><p>The pool still sees liquidity and trades, so prices stay honest. It never sees who's behind them.</p></div>
            <div className="seeing reveal" aria-label="Example: the same position, as a block explorer shows it and as you see it in Veyl">
              <div className="sv pub"><span className="sv-k">What anyone sees on-chain</span>
                <dl><div><dt>Sent by</dt><dd>Veyl relayer</dd></div><div><dt>Pool</dt><dd>SOL–USDC</dd></div><div><dt>Bins</dt><dd>+ liquidity in 11 bins</dd></div><div><dt>Owner</dt><dd className="x">hidden</dd></div><div><dt>Size</dt><dd className="x">hidden</dd></div><div><dt>Fees earned</dt><dd className="x">hidden</dd></div></dl></div>
              <div className="sv you"><span className="sv-k">What only you see</span>
                <dl><div><dt>Your position</dt><dd>12.4 SOL + 1,830 USDC</dd></div><div><dt>Range</dt><dd>11 bins around the price</dd></div><div><dt>Fees earned</dt><dd>3.21 USDC</dd></div><div><dt>Your wallet</dt><dd>never signed it</dd></div></dl>
                <span className="sv-ex">Example</span></div>
            </div>
            <div className="privgrid reveal">
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="10" rx="2.5" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></svg></span><h3>Private balance</h3><p>Deposit once. Your tokens become private notes that only you can spend.</p></div>
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 20V14M9 20V9M14 20V5M19 20V11" /></svg></span><h3>Private positions</h3><p>Your liquidity sits in the bins with everyone else's. Size, range and earnings stay yours.</p></div>
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 12h13M12 7l5 5-5 5" /><circle cx="20" cy="12" r="1.6" /></svg></span><h3>No wallet signature</h3><p>A relayer sends your transaction, so your wallet never shows up next to it.</p></div>
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><path d="M3.5 10h17" /></svg></span><h3>Sealed swaps</h3><p>Swaps are sealed and settled together in batches. Nobody can see your order and jump ahead of it.</p></div>
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l2.5 2.5" /></svg></span><h3>Proofs on your device</h3><p>The maths that proves it's your money is done in your browser. Your keys never leave it.</p></div>
              <div className="pv"><span className="pv-i" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /></svg></span><h3>Withdraw anywhere</h3><p>Take your tokens out to any wallet, even a brand-new one, with no link back to where they came from.</p></div>
            </div>
          </div>
        </section>

        <section id="start" className="sec cta">
          <div className="w reveal">
            <h2>Liquidity,<br /><em>without a name.</em></h2>
            <div className="btn-row" style={{ marginTop: 32 }}>
              <a className="btn primary lg" href="app.html#pools">Add liquidity</a>
              <a className="btn ghost lg" href="docs.html">Read the docs</a>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
      <LegacyScripts srcs={['veyl.config.js', asset('home.js')]} />
    </>
  );
}
