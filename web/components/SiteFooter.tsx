// The marketing pages' footer (homepage and docs), identical markup to the old static pages.
export default function SiteFooter() {
  return (
    <footer>
      <div className="w">
        <div>
          <a className="brand" href="index.html" aria-label="Veyl home"><img className="lockup" src="brand/veyl-lockup.svg" alt="Veyl" /></a>
          <p className="tagline">Liquidity, <em>without a name.</em></p><p style={{ marginTop: 10, maxWidth: '34ch' }}>Private DLMM liquidity on Solana.</p>
        </div>
        <div>
          <h4>App</h4>
          <ul><li><a href="app.html#pools">Pools</a></li><li><a href="app.html#swap">Swap</a></li><li><a href="app.html#home">Portfolio</a></li></ul>
        </div>
        <div>
          <h4>Learn</h4>
          <ul><li><a href="docs.html">Docs</a></li><li><a href="docs.html#privacy">Privacy</a></li><li><a href="docs.html#faq">FAQ</a></li><li><a href="docs.html#roadmap">Roadmap</a></li></ul>
        </div>
        <p className="fine">Veyl has not yet had an independent audit. Built on Solana; not affiliated with the Solana Foundation or Solana Labs. Concentrated liquidity can lose value against holding.</p>
      </div>
    </footer>
  );
}
