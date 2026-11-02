#!/usr/bin/env node
// Regenerates the brand kit in brand/ from the owner's two masters: web/public/logo.png (the ghost) and
// web/public/Frame 353.png (the ghost beside the "Veyl" wordmark). Both are traced, not redrawn: the ghost into its parts
// (silhouette, body inside the white outline, hood, two eyes) so the site can animate them, the wordmark into outlines.
// Writes the SVG marks and lockups (colour, light-ground and single-colour), the favicons, the app icons and og.png.
//   node scripts/brand.js            (og.png needs Playwright's Chromium; everything else only sharp)
'use strict';
const fs = require('fs'); const path = require('path'); const sharp = require('sharp');
const R = path.join(__dirname, '..'); const BRAND = path.join(R, 'brand'); const PUB = path.join(R, 'web/public');

// ---- tracing: flood fills, a distance transform, crack-following outlines, smoothing and simplification ----
function flood(W, H, ok, seeds) {
  const m = new Uint8Array(W * H); const st = [];
  for (const [x, y] of seeds) { const i = y * W + x; if (ok(i)) { m[i] = 1; st.push(i); } }
  while (st.length) { const i = st.pop(); const x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx; if (!m[j] && ok(j)) { m[j] = 1; st.push(j); } } }
  return m;
}
function dist(W, H, m) { // chamfer distance to the nearest pixel outside the mask
  const d = new Float32Array(W * H); for (let i = 0; i < W * H; i++) d[i] = m[i] ? 1e9 : 0; const b = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!d[i]) continue;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1); if (y > 0) { d[i] = Math.min(d[i], d[i - W] + 1); if (x > 0) d[i] = Math.min(d[i], d[i - W - 1] + b); if (x < W - 1) d[i] = Math.min(d[i], d[i - W + 1] + b); } }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const i = y * W + x; if (!d[i]) continue;
    if (x < W - 1) d[i] = Math.min(d[i], d[i + 1] + 1); if (y < H - 1) { d[i] = Math.min(d[i], d[i + W] + 1); if (x < W - 1) d[i] = Math.min(d[i], d[i + W + 1] + b); if (x > 0) d[i] = Math.min(d[i], d[i + W - 1] + b); } }
  return d;
}
function outline(W, H, m) { // the boundary of the top-most component, walked along pixel edges with the inside on the right
  let s = -1; for (let i = 0; i < W * H; i++) if (m[i]) { s = i; break; }
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !!m[y * W + x]; const D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const ahead = (x, y, d) => [[[x, y], [x, y - 1]], [[x - 1, y], [x, y]], [[x - 1, y - 1], [x - 1, y]], [[x, y - 1], [x - 1, y - 1]]][d];
  let x = s % W, y = (s / W) | 0, d = 0; const sx = x, sy = y; const pts = [];
  for (let k = 0; k < 400000; k++) { pts.push([x, y]); const [[rx, ry], [lx, ly]] = ahead(x, y, d);
    if (!at(rx, ry)) d = (d + 1) % 4; else if (at(lx, ly)) d = (d + 3) % 4; x += D[d][0]; y += D[d][1]; if (x === sx && y === sy) break; }
  return pts;
}
const smooth = (p, w) => p.map((_, i) => { let sx = 0, sy = 0; for (let k = -w; k <= w; k++) { const q = p[(i + k + p.length) % p.length]; sx += q[0]; sy += q[1]; } return [sx / (2 * w + 1), sy / (2 * w + 1)]; });
function rdp(p, eps) { if (p.length < 3) return p; const a = p[0], b = p[p.length - 1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; let mi = 0, md = 0;
  for (let i = 1; i < p.length - 1; i++) { const d = Math.abs(dy * p[i][0] - dx * p[i][1] + b[0] * a[1] - b[1] * a[0]) / L; if (d > md) { md = d; mi = i; } }
  return md <= eps ? [a, b] : rdp(p.slice(0, mi + 1), eps).slice(0, -1).concat(rdp(p.slice(mi), eps)); }
function pathOf(W, H, m, w, eps) { const p = smooth(outline(W, H, m), w), h = (p.length / 2) | 0;
  const q = rdp(p.slice(0, h + 1), eps).slice(0, -1).concat(rdp(p.slice(h).concat([p[0]]), eps).slice(0, -1));
  return 'M' + q.map(([x, y]) => +x.toFixed(1) + ' ' + +y.toFixed(1)).join('L') + 'Z'; }
function ellipse(W, H, m) { let n = 0, sx = 0, sy = 0; for (let i = 0; i < W * H; i++) if (m[i]) { n++; sx += i % W; sy += (i / W) | 0; }
  const cx = sx / n, cy = sy / n; let xx = 0, yy = 0, xy = 0;
  for (let i = 0; i < W * H; i++) if (m[i]) { const dx = i % W - cx, dy = ((i / W) | 0) - cy; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
  xx /= n; yy /= n; xy /= n; const t = xx + yy, r = Math.sqrt(t * t / 4 - (xx * yy - xy * xy));
  return { cx: +cx.toFixed(1), cy: +cy.toFixed(1), rx: +(2 * Math.sqrt(t / 2 + r)).toFixed(1), ry: +(2 * Math.sqrt(t / 2 - r)).toFixed(1), a: +(0.5 * Math.atan2(2 * xy, xx - yy) * 180 / Math.PI).toFixed(1) }; }
async function grey(file) { const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true }); return { W: info.width, H: info.height, L: (i) => data[i * info.channels] }; }

// the ghost, from logo.png: background < 100, a white outline ~19 px, the hood < 110, two white eyes inside the hood
async function traceGhost() {
  const { W, H, L } = await grey(path.join(PUB, 'logo.png'));
  const bg = flood(W, H, (i) => L(i) < 100, [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]);
  const sil = bg.map((v) => (v ? 0 : 1)); const hood = flood(W, H, (i) => L(i) < 110 && sil[i], [[420, 330]]);
  const e1 = flood(W, H, (i) => L(i) >= 110, [[380, 480]]), e2 = flood(W, H, (i) => L(i) >= 110, [[487, 400]]);
  const ds = dist(W, H, sil); const body = sil.map((v, i) => (ds[i] > 19 ? 1 : 0));
  return { sil: pathOf(W, H, sil, 3, 0.6), body: pathOf(W, H, body, 3, 0.6), hood: pathOf(W, H, hood.map((v, i) => v || e1[i] || e2[i]), 2, 0.5), eyes: [ellipse(W, H, e1), ellipse(W, H, e2)], box: [288, 258, 404, 512] };
}
// the wordmark, from Frame 353.png: every bright component right of the ghost, plus the counters inside the letters
async function traceWord() {
  const { W, H, L } = await grey(path.join(PUB, 'Frame 353.png')); const on = (i) => L(i) >= 128; const seen = new Uint8Array(W * H); const comps = [];
  for (let i = 0; i < W * H; i++) { if (seen[i] || !on(i)) continue; const m = flood(W, H, (j) => on(j) && !seen[j], [[i % W, (i / W) | 0]]); let n = 0; const bb = [W, H, 0, 0];
    for (let j = 0; j < W * H; j++) if (m[j]) { seen[j] = 1; n++; const x = j % W, y = (j / W) | 0; bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); }
    if (n > 30) comps.push({ m, bb }); }
  const ghost = comps.filter((c) => c.bb[0] < 445), word = comps.filter((c) => c.bb[0] >= 445); let d = '';
  const gb = ghost.reduce((a, c) => [Math.min(a[0], c.bb[0]), Math.min(a[1], c.bb[1]), Math.max(a[2], c.bb[2]), Math.max(a[3], c.bb[3])], [W, H, 0, 0]);
  for (const c of word) { d += pathOf(W, H, c.m, 1, 0.35); const [x0, y0, x1, y1] = c.bb; const done = new Uint8Array(W * H);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (done[i] || c.m[i]) continue;
      const h = flood(W, H, (j) => !c.m[j] && j % W >= x0 && j % W <= x1 && ((j / W) | 0) >= y0 && ((j / W) | 0) <= y1, [[x, y]]); let edge = false, n = 0;
      for (let j = 0; j < W * H; j++) if (h[j]) { done[j] = 1; n++; const xx = j % W, yy = (j / W) | 0; if (xx === x0 || xx === x1 || yy === y0 || yy === y1) edge = true; }
      if (!edge && n > 20) d += pathOf(W, H, h, 1, 0.35); } }
  return { d, ghostBox: gb };
}

// ---- drawing ----
const eyeEl = (e, fill) => `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx}" ry="${e.ry}" transform="rotate(${e.a} ${e.cx} ${e.cy})" fill="${fill}"/>`;
// colour ghost: outline, a satin body, a black hood, white eyes. `p` prefixes the gradient ids; `edge` is the outline colour
function ghostColour(g, p = 'v', edge = '#fff') {
  return `<defs><linearGradient id="${p}b" gradientUnits="userSpaceOnUse" x1="520" y1="520" x2="650" y2="720"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#a2a2a2"/></linearGradient>`
    + `<linearGradient id="${p}h" gradientUnits="userSpaceOnUse" x1="480" y1="300" x2="440" y2="590"><stop offset="0" stop-color="#000"/><stop offset=".45" stop-color="#090909"/><stop offset="1" stop-color="#474747"/></linearGradient></defs>`
    + `<path d="${g.sil}" fill="${edge}"/><path d="${g.body}" fill="url(#${p}b)"/><path d="${g.hood}" fill="url(#${p}h)"/>${g.eyes.map((e) => eyeEl(e, '#fff')).join('')}`;
}
// one colour: the silhouette with the hood cut out and the eyes left standing in it
const ghostMono = (g, c) => `<path d="${g.sil}${g.hood}" fill="${c}" fill-rule="evenodd"/>${g.eyes.map((e) => eyeEl(e, c)).join('')}`;
const svg = (vb, body, label = 'Veyl') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="${label}"><title>${label}</title>${body}</svg>\n`;
// the lockup keeps Frame 353's layout: the ghost (traced at 1000 px) scaled into the frame's ghost box, then the wordmark
function lockup(g, w, ghost, word) {
  const [gx0, gy0, gx1, gy1] = w.ghostBox, k = ((gx1 - gx0) / 394 + (gy1 - gy0) / 502) / 2;
  return `<g transform="translate(${gx0} ${gy0}) scale(${k.toFixed(4)}) translate(-293 -263)">${ghost}</g><path d="${w.d}" fill="${word}"/>`;
}
const LOCK_VB = '294 393 413 204', MARK_VB = (g) => g.box.join(' ');
const tile = (g, size, pad) => { const [x, y, w, h] = g.box, s = Math.max(w, h) / (1 - 2 * pad); const ox = x - (s - w) / 2, oy = y - (s - h) / 2; return { vb: `${ox.toFixed(1)} ${oy.toFixed(1)} ${s.toFixed(1)} ${s.toFixed(1)}`, s, ox, oy }; };

(async () => {
  const g = await traceGhost(), w = await traceWord(); const out = (f, s) => { fs.writeFileSync(path.join(BRAND, f), s); console.log('brand/' + f); };
  out('veyl-mark.svg', svg(MARK_VB(g), ghostColour(g)));
  out('veyl-mark-small.svg', svg(MARK_VB(g), ghostColour(g, 's')));
  out('veyl-mark-light.svg', svg(MARK_VB(g), ghostColour(g, 'l', '#0A0A0B')));
  out('veyl-lockup.svg', svg(LOCK_VB, lockup(g, w, ghostColour(g), '#F4F4F2')));
  out('veyl-lockup-light.svg', svg(LOCK_VB, lockup(g, w, ghostColour(g, 'l', '#0A0A0B'), '#0A0A0B')));
  for (const [n, c] of [['black', '#000'], ['white', '#fff'], ['dark', '#0A0A0B'], ['light', '#F4F4F2'], ['currentcolor', 'currentColor']]) {
    out('mono/veyl-mark-' + n + '.svg', svg(MARK_VB(g), ghostMono(g, c))); out('mono/veyl-lockup-' + n + '.svg', svg(LOCK_VB, lockup(g, w, ghostMono(g, c), c))); }
  // the app icon: the ghost on the master's own dark tile
  const t = tile(g, 64, 0.17), r = (t.s * 0.225).toFixed(1);
  const icon = svg(t.vb, `<defs><radialGradient id="tg" cx=".78" cy=".92" r="1"><stop offset="0" stop-color="#2E2E30"/><stop offset=".55" stop-color="#0C0C0D"/><stop offset="1" stop-color="#050505"/></radialGradient></defs><rect x="${t.ox.toFixed(1)}" y="${t.oy.toFixed(1)}" width="${t.s.toFixed(1)}" height="${t.s.toFixed(1)}" rx="${r}" fill="url(#tg)"/>${ghostColour(g, 'f')}`);
  out('favicon.svg', icon);
  // the same parts for the site's live ghost (web/components/Ghost.tsx), which moves its eyes
  fs.writeFileSync(path.join(R, 'web/lib/ghost.ts'), '// Generated by scripts/brand.js from web/public/logo.png: the ghost\'s traced parts (viewBox ' + MARK_VB(g) + '). Do not edit by hand.\n'
    + 'export const GHOST = ' + JSON.stringify({ box: g.box, sil: g.sil, body: g.body, hood: g.hood, eyes: g.eyes }, null, 1) + ' as const;\n'); console.log('web/lib/ghost.ts');
  fs.writeFileSync(path.join(BRAND, 'mark-path.txt'), 'Traced from web/public/logo.png by scripts/brand.js (viewBox ' + MARK_VB(g) + ').\nsilhouette:\n' + g.sil + '\nbody:\n' + g.body + '\nhood (eyes included):\n' + g.hood + '\neyes:\n' + JSON.stringify(g.eyes) + '\nwordmark (Frame 353.png space, viewBox ' + LOCK_VB + '):\n' + w.d + '\n');
  const png = async (src, size, f) => { const vw = +/viewBox="[^ ]+ [^ ]+ ([^ ]+)/.exec(src)[1]; await sharp(Buffer.from(src), { density: Math.min(2400, 72 * size * 2 / vw) }).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path.join(BRAND, f)); console.log('brand/' + f); };
  await png(icon, 32, 'favicon-32.png'); await png(icon, 180, 'apple-touch-icon.png'); await png(icon, 512, 'veyl-app-icon-512.png');
  await png(svg(tile(g, 64, 0.06).vb, ghostColour(g)), 512, 'veyl-mark-512.png'); await png(svg(tile(g, 64, 0.06).vb, ghostMono(g, '#F4F4F2')), 512, 'png-mark-512-dark.png');
  // og.png, 1200 x 630: the lockup, the positioning line, the black of the master
  let chromium; try { ({ chromium } = require('playwright')); } catch { console.log('og.png skipped: Playwright is not installed'); return; }
  const html = `<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400&display=block"><style>
    html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#050505}
    body{background:radial-gradient(90% 120% at 80% 112%,#262628 0,#0d0d0e 48%,#050505 78%);display:grid;place-items:center;font-family:Manrope,system-ui,sans-serif}
    .c{display:grid;justify-items:center;gap:34px;transform:translateY(-4px)} .c svg{width:520px;height:auto;display:block}
    p{margin:0;color:#A9ABA6;font-weight:300;font-size:34px;letter-spacing:-.02em} p b{font-weight:400;color:#F4F4F2}
  </style></head><body><div class="c">${svg(LOCK_VB, lockup(g, w, ghostColour(g), '#F4F4F2'))}<p><b>Concentrated liquidity,</b> kept private.</p></div></body></html>`;
  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1200, height: 630 } }); await pg.setContent(html, { waitUntil: 'networkidle' }).catch(() => {});
  await pg.evaluate(() => document.fonts.ready); await pg.screenshot({ path: path.join(BRAND, 'og.png') }); await b.close(); console.log('brand/og.png');
})();
