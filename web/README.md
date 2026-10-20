# web/: the site as a Next.js project (static export)

Next.js App Router, `output: 'export'`, `trailingSlash: false`. Routes `/`, `/docs`, `/app` export to `index.html`,
`docs.html`, `app.html`, so every existing link (`app.html#pools`, `docs.html#faq`) keeps working. Nothing here is built on
its own: `npm run build:site -- --network <net>` (scripts/build-site.js) runs `next build` in web/ (skipped when no input
changed), copies the three pages and `_next/` into dist/site/, then adds the site/ files (styles, the engine bundle, workers,
snarkjs), the zk files, the Sandbox files, veyl.config.js, veyl.keys.js, `_headers` and vercel.json. The deps live in the
root package.json.

| Route | Source | Notes |
|---|---|---|
| `/app` | `app/app/page.tsx` → `features/` | The app: React components on top of the browser engine. Architecture, rules and how it talks to the programs: **INTEGRATION.md**. |
| `/` | `app/page.tsx` | Static markup; behaviour in `site/home.js` (loaded by `LegacyScripts`). |
| `/docs` | `app/docs/page.tsx` | Static markup; `app/docs/DocsEffects.tsx` for its small interactions. |

## Layout
- `app/`: the three routes. `components/`: shared parts (`PageHead`, `SiteNav`, `SiteFooter`, `IconSprite`, `overlay` = the
  dialog and toasts, `ui/` = primitives). `lib/`: pure helpers (`format`, `storage`, `store`, `tokens`) and `lib/veyl/` = the
  engine boundary (`runtime.ts`, `types.ts`, `services/`). `features/<screen>/`: one folder per screen or concern.
- Styles: `site/veyl.css` (tokens, shared) and `site/app.css` (the app). Components use their classes; there is no CSS in web/.

## Head tags
Render `<PageHead title=… description=… styles={[asset('app.css')]} />` first in a page. The root layout already adds the
charset, viewport (`viewport-fit=cover`), theme-color, color-scheme, icons, preconnects, Google Fonts and `veyl.css`. Don't use
the Metadata API: it rewrites `brand/og.png` into an absolute URL. React 19 hoists the tags into `<head>`; stylesheets carry
`precedence`, which keeps `veyl.css` before `app.css`. Use plain `<a href="app.html#…">`, never `next/link`.

## How scripts load
- `/app` loads its runtime itself (`lib/veyl/runtime.ts`): `veyl.config.js`, `sandbox.config.js`, `veyl.keys.js`,
  `snarkjs.min.js`, `qrcode.js`, `veyl-sol.js`, in order, after the page has hydrated. The exported HTML is the frame and a
  loading state; everything that needs the engine renders once it is ready.
- `/` keeps `site/home.js` through `LegacyScripts`: it preloads the file from `<head>` and inserts it in the hydration commit,
  so it runs right after hydration on a DOM React won't re-render. Never write `<script>` in JSX, and never use `next/script`.

## CSP
The exported HTML contains Next's inline bootstrap and flight-data scripts. build-site moves each of them into a
content-hashed file next to the page (`docs.<hash>.js`, keeping attributes such as `id`), so `script-src 'self'
'wasm-unsafe-eval'` stays as it was, with no `'unsafe-inline'` and no per-build hashes. This matters because netlify.toml and
the root vercel.json carry a static CSP that applies alongside dist/site/_headers. The build fails if any executable inline
script or `on*=` attribute is left. Next's chunks load from `/_next/` (absolute), so the site must be served from the domain
root, as every host config already does.

## Local
- Devnet, everything on this machine: `RPC_URL=<devnet RPC> COMMITTEE=1 scripts/devnet-local.sh`, then
  http://localhost:8895/app.html?mode=devnet.
- Sandbox (in-browser chain, real proofs): `npm run build:site -- --network devnet && node scripts/serve-dist.js 8895`, then
  http://localhost:8895/app.html?mode=sandbox-dev.
- Typecheck: `npx tsc --noEmit -p web`. `next dev` is not wired up: the static files it needs come from build-site.
- e2e suites drive `/app.html` by element ids (`e2e/*.js`); keep the ids and `data-*` attributes they select on.
