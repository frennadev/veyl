// The marketing pages' sticky header. links: [href, label, current?]; `current` sets aria-current="page".
export default function SiteNav({ links }: { links: [href: string, label: string, current?: boolean][] }) {
  return (
    <header className="nav" id="nav">
      <div className="w">
        <a className="brand" href="index.html" aria-label="Veyl home"><img className="lockup" src="brand/veyl-lockup.svg" alt="Veyl" /></a>
        <nav className="nav-links" aria-label="Site">
          {links.map(([href, label, current]) => <a key={href} href={href} aria-current={current ? 'page' : undefined}>{label}</a>)}
        </nav>
        <span className="status" title="Veyl runs on Solana."><i></i>Solana</span>
        <a className="btn primary" href="app.html">Open app</a>
      </div>
    </header>
  );
}
