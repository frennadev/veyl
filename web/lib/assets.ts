// Content-hashed names of the pages' own files (app.js, app.css, home.js). scripts/build-site.js hashes them first and passes
// the map as VEYL_ASSETS when it runs `next build`, so the HTML names e.g. app.3f2a9c1b0d4e.js. Read at build time only
// (server components); without the variable (plain `next build` / `next dev`) a file keeps its plain name.
const MAP: Record<string, string> = (() => { try { return JSON.parse(process.env.VEYL_ASSETS || '{}'); } catch { return {}; } })();
export const asset = (name: string): string => MAP[name] || name;
