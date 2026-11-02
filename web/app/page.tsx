// / (exported as index.html). The ghost stage: public deposits drift in from the left, pass into the ghost (your browser's
// proof) and come out as identical private pieces that settle into the liquidity bins on the right. Behaviour (the stage
// canvas, the ghost's eyes, the liquidity showcase, the veil-lift reveals) is in site/home.js, loaded by <LegacyScripts>
// after hydration; React renders this markup once and never re-renders it, so home.js may change it freely. The ids the e2e
// suites drive (#flow, #flowCv, #how, #lp*, #pools, #poolRows, #poolsNote, #privacy) stay as they were.
import PageHead from '@/components/PageHead';
import SiteNav from '@/components/SiteNav';
import SiteFooter from '@/components/SiteFooter';
import LegacyScripts from '@/components/LegacyScripts';
import Ghost from '@/components/Ghost';
import { asset } from '@/lib/assets';

const DESCRIPTION = 'Veyl is concentrated DLMM liquidity on Solana, private by default: choose your range and shape, earn dynamic fees, and keep your position to yourself.';
const OG_TITLE = 'Veyl: concentrated liquidity, kept private';
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

// [title, what it does, what stays private]
const TOOLS: [string, string, string][] = [
  ['Spot, Curve, Bid-Ask', 'Spread evenly, stack it around the price, or weight the edges for a big move.', 'who owns it and how big'],
  ['Fees that move with the market', 'Fees rise when the price moves fast, so you earn more when it matters. Never above 10%.', 'what you earn'],
  ['Limit orders', 'Park tokens in one bin. It fills when the price crosses, and earns fees while it waits.', 'whose order it is'],
  ['Zap in', 'Only hold one token? Zap swaps part of it and adds both sides in one step.', 'paid from your private balance'],
  ['One-tap rebalance', 'Price moved out of range? Re-centre your liquidity around it and keep your shape.', 'not linked to your earlier moves'],
  ['Claim any time', 'Fees build up in your position. Claim them, or take 25%, 50% or all of it out.', 'lands in your private balance'],
];

// [title, one line]
const PRIVACY: [string, string][] = [
  ['Private balance', 'Deposit once. Your tokens become private notes that only you can spend.'],
  ['Private positions', 'Your liquidity sits in the bins with everyone else\'s. Size, range and earnings stay yours.'],
  ['No wallet signature', 'A relayer sends your transaction, so your wallet never shows up next to it.'],
  ['Sealed swaps', 'Swaps are sealed and settled together in batches. Nobody can see your order and jump ahead of it.'],
  ['Proofs on your device', 'The maths that proves it\'s your money is done in your browser. Your keys never leave it.'],
  ['Withdraw anywhere', 'Take your tokens out to any wallet, even a brand-new one, with no link back to where they came from.'],
];

export default function Home() {
  return (
    <>
      <PageHead title="Veyl" description={DESCRIPTION} ogTitle={OG_TITLE} ogDescription={OG_DESCRIPTION} />
      <a className="skip" href="#main">Skip to content</a>
      <SiteNav links={[['#how', 'Liquidity'], ['#pools', 'Pools'], ['#privacy', 'Privacy'], ['docs.html', 'Docs']]} />

      <main id="main" className="home">
        <section className="stage-sec" aria-labelledby="heroTitle">
          <figure className="stage" id="flow" aria-label="Deposits of different sizes drift into the ghost, which stands for the proof your browser makes, and come out as identical private pieces that fill the liquidity bins.">
            <canvas id="flowCv" aria-hidden="true"></canvas>
            <div className="ghost-wrap" id="ghostWrap"><Ghost id="gh" className="ghost hero-ghost" /><i className="ghost-floor" aria-hidden="true"></i></div>
            <div className="flow-tags" aria-hidden="true">
              <span className="ft in" data-stage="0">Public deposits</span>
              <span className="ft gate" data-stage="1">Proof, on your device</span>
              <span className="ft out" data-stage="2">Bins, unlinked</span>
            </div>
          </figure>
          <div className="w hero-foot">
            <h1 id="heroTitle">Concentrated liquidity,<br /><em>kept private.</em></h1>
            <div className="hero-side">
              <p className="sub">Provide into price bins on Solana and earn fees that rise with the market. The pool sees the liquidity. Nobody sees whose it is, or how much.</p>
              <div className="btn-row">
                <a className="btn primary lg" href="app.html#pools">Add liquidity</a>
                <a className="btn ghost lg" href="#how">How it works</a>
              </div>
              <p className="nowallet"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.9-4.3-1.7-7.5-5.3-7.5-9.9V6z" /></svg>No wallet needed. Fund a deposit address from any wallet or exchange.</p>
            </div>
          </div>
        </section>

        <section id="how" className="hsec tryit">
          <div className="w">
            <header className="hhead veil"><h2>Pick a range.<br /><em>Earn privately.</em></h2><p>Liquidity sits in price bins. Choose a pool, a shape and how many bins around the price. Every swap through your bins pays you.</p></header>
            <div className="trygrid">
              <div className="trycard" id="lpCard" aria-live="polite">
                <div className="tc-h"><label className="poolsel"><span className="dots" id="lpDots"><i className="c-eth"></i><i className="c-usdc"></i></span><select id="lpPool" aria-label="Pool"><option value="sol-usdc">SOL–USDC</option><option value="sol-usdt">SOL–USDT</option><option value="usdt-usdc">USDT–USDC</option></select></label><span className="tc-mk" id="lpMk">Bin step 0.10% · base fee 0.05%</span></div>
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
                <div className="tryseen" id="lpSeen"><div className="pb"><b>The chain sees</b><p>The pool, a change per bin, the relayer&apos;s flat fee, spent-note tags.</p></div><div className="hd"><b>It does not see</b><p>Whose position it is, how large, what you earned, or your wallet: it never signs.</p></div></div>
                <p className="trynote"><a href="docs.html#privacy">What is and isn&apos;t private</a></p>
              </div>
            </div>
          </div>
        </section>

        <section id="tools" className="hsec">
          <div className="w">
            <header className="hhead veil"><h2>Every LP tool.<br /><em>All of it private.</em></h2><p>The tools you&apos;d expect from the best liquidity apps on Solana. Each one runs from your private balance, so none of it points back to your wallet.</p></header>
            <ol className="toolist veil">
              {TOOLS.map(([t, d, p], i) => (
                <li key={t}><span className="n">{String(i + 1).padStart(2, '0')}</span><h3>{t}</h3><p>{d}</p><span className="pv-p"><Lock />Private: {p}</span></li>
              ))}
            </ol>
          </div>
        </section>

        <section id="pools" className="hsec">
          <div className="w">
            <header className="hhead veil"><h2>Deep pairs.<br /><em>Ready for your range.</em></h2><p>83 curated pools: every major Meteora pair, from SOL–USDC to the top memecoins and tokenized stocks, each listed by Veyl. Pick a pair, choose your range and start earning.</p></header>
            <div className="livepools veil" id="livePools">
              <table className="tbl" aria-describedby="poolsNote">
                <thead><tr><th>Pool</th><th className="num">Bin step</th><th className="num">Base fee</th><th className="num">Type</th></tr></thead>
                <tbody id="poolRows">
                  {POOLS.map(([id, label, [a, b], step, fee, type]) => (
                    <tr key={id}><td><a className="pair" href={`app.html#pool-${id}`}><span className="dots"><i className={a}></i><i className={b}></i></span><span><b>{label}</b></span></a></td><td className="num">{step}</td><td className="num">{fee}</td><td className="num">{type}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pools-foot"><p className="small muted" id="poolsNote">The 12 deepest shown. 71 more in the app, including HYPE, TRUMP, cbBTC, PUMP, PENGU and JupSOL. Every pool is private; fees never go above 10%.</p><a className="btn ghost" href="app.html#pools">See all 83 pools</a></div>
          </div>
        </section>

        <section id="privacy" className="hsec">
          <div className="w">
            <header className="hhead veil"><h2>Your position.<br /><em>Nobody else&apos;s business.</em></h2><p>The pool still sees liquidity and trades, so prices stay honest. It never sees who&apos;s behind them.</p></header>
            <div className="seeing veil" id="seeing" aria-label="Example: the same position, as a block explorer shows it and as you see it in Veyl">
              <div className="sv pub"><span className="sv-k">What anyone sees on-chain</span>
                <dl><div><dt>Sent by</dt><dd>Veyl relayer</dd></div><div><dt>Pool</dt><dd>SOL–USDC</dd></div><div><dt>Bins</dt><dd>+ liquidity in 11 bins</dd></div><div><dt>Owner</dt><dd className="x">hidden</dd></div><div><dt>Size</dt><dd className="x">hidden</dd></div><div><dt>Fees earned</dt><dd className="x">hidden</dd></div></dl></div>
              <div className="sv-gate" aria-hidden="true"><Ghost id="gs" className="ghost mini-ghost" /></div>
              <div className="sv you"><span className="sv-k">What only you see <em className="sv-ex">Example</em></span>
                <dl><div><dt>Your position</dt><dd>12.4 SOL + 1,830 USDC</dd></div><div><dt>Range</dt><dd>11 bins around the price</dd></div><div><dt>Fees earned</dt><dd>3.21 USDC</dd></div><div><dt>Your wallet</dt><dd>never signed it</dd></div></dl></div>
            </div>
            <ul className="plist veil">
              {PRIVACY.map(([t, d]) => <li key={t}><h3>{t}</h3><p>{d}</p></li>)}
            </ul>
          </div>
        </section>

        <section id="start" className="hsec cta">
          <div className="w">
            <div className="cta-ghost" aria-hidden="true"><Ghost id="gc" className="ghost cta-g" /></div>
            <h2>Liquidity,<br /><em>without a name.</em></h2>
            <div className="btn-row">
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
