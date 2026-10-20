// Veyl's site as a Next.js static export. scripts/build-site.js runs `next build` here and copies out/ into dist/site/.
// Same URLs as the old static pages: out/index.html, out/docs.html, out/app.html (trailingSlash: false).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** @type {import('next').NextConfig} */
export default {
  output: 'export',
  trailingSlash: false,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  turbopack: { root },           // one lockfile, at the repo root
  outputFileTracingRoot: root,
};
