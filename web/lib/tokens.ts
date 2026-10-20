// Token marks, drawn on a canvas and cached as data URLs: never fetched from a third party (no token-list request reveals
// which pools a visitor looks at). Same drawings as site/app.js. Browser only (needs a canvas). Tokens web3icons covers use
// its brand mark instead (tokenIcons.ts).
import { brandLogo } from './tokenIcons';

interface Mark { name: string; c: string; g: string }
const KNOWN: Record<string, Mark> = {
  WIF: { name: 'dogwifhat', c: '#B07A4F', g: 'T:W' }, JTO: { name: 'Jito', c: '#5B7F86', g: 'T:J' }, PYTH: { name: 'Pyth Network', c: '#6E5A9E', g: 'T:P' },
  RAY: { name: 'Raydium', c: '#4A63A8', g: 'T:R' }, JUP: { name: 'Jupiter', c: '#4F8F7A', g: 'jup' }, SOL: { name: 'Solana', c: '#8E98A6', g: 'sol' },
  USDC: { name: 'USD Coin', c: '#3B5410', g: 'dollar' }, USDT: { name: 'Tether USD', c: '#5E6B7C', g: 'dollar' }, BONK: { name: 'Bonk', c: '#D9843B', g: 'bonk' },
  WISP: { name: 'Wisp · made-up, volatile', c: '#6F7C93', g: 'wisp' },
};
const NAMES: Record<string, string> = {
  HYPE: 'Hyperliquid', TRUMP: 'Official Trump', MU: 'Micron (tokenized)', STONK: 'STONK', cbBTC: 'Coinbase Wrapped BTC', TTWO: 'Take-Two (tokenized)',
  SKHY: 'SKHY', SI: 'SI', BP: 'BP', SPCX: 'SpaceX (tokenized)', wNEAR: 'Wrapped NEAR', PUMP: 'Pump.fun', MUSK: 'MUSK', ZEC: 'Zcash', WETH: 'Wrapped Ether',
  MET: 'Meteora', ANSEM: 'ANSEM', BORDR: 'BORDR', ANTFUN: 'ANTFUN', DOPE: 'DOPE', CARDS: 'CARDS', STRK: 'Starknet', baton: 'baton', ORE: 'Ore',
  HOOKED: 'HOOKED', CLAUDIA: 'CLAUDIA', Agency: 'Agency', NVDAx: 'NVIDIA xStock', MASK: 'MASK', wXMR: 'Wrapped Monero', DARK: 'DARK', ZCAT: 'ZCAT',
  ENA: 'Ethena', DOGE: 'Dogecoin', Dacity: 'Dacity', PENGU: 'Pudgy Penguins', LOAD: 'LOAD', PEPE: 'Pepe', CTM: 'CTM', GOOGLx: 'Alphabet xStock',
  WBTC: 'Wrapped BTC', USDe: 'Ethena USDe', USDG: 'Global Dollar', JEANPHIL: 'JEANPHIL', SNDK: 'SanDisk (tokenized)', JupSOL: 'Jupiter Staked SOL',
  JitoSOL: 'Jito Staked SOL', CRAWL: 'CRAWL', DBR: 'DBR', OMNI: 'OMNI', USELESS: 'USELESS', JLP: 'Jupiter LP', CATE: 'CATE', FTR: 'FTR',
  ANTHROPIC: 'ANTHROPIC', INF: 'Sanctum Infinity', swordcat: 'swordcat', INJ: 'Injective', JupUSD: 'Jupiter USD', VEIL: 'VEIL',
};

const hueHex = (h: number) => {
  const f = (n: number) => { const k = (n + h / 30) % 12, a = 0.28 * Math.min(0.42, 1 - 0.42); return Math.round(255 * (0.42 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
};
export function tokenMark(sym: string): Mark {
  return KNOWN[sym] ??= {
    name: NAMES[sym] || sym,
    c: hueHex([...sym].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7)),
    g: 'T:' + sym.replace(/^[a-z]+(?=[A-Z])/, '').slice(0, 1).toUpperCase(),
  };
}
export const tokenName = (sym: string): string => tokenMark(sym).name;

function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255; const t = f < 0 ? 0 : 255, p = Math.abs(f);
  r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b); return `rgb(${r},${g},${b})`;
}
type Ctx = CanvasRenderingContext2D;
function glyph(g: Ctx, k: string) {
  const cut = (f: () => void) => { g.save(); g.globalCompositeOperation = 'destination-out'; f(); g.restore(); };
  const poly = (pts: number[][]) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); };
  const text = (s: string, font: string) => { g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s, 64, 68); };
  if (k === 'sol') { [[30, 40, 98, 40, 86, 54, 18, 54], [18, 60, 86, 60, 98, 74, 30, 74], [30, 80, 98, 80, 86, 94, 18, 94]].forEach((q) => { poly([[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]); g.fill(); }); }
  else if (k.startsWith('T:')) text(k.slice(2), '700 58px Manrope, Arial, sans-serif');
  else if (k === 'dollar') text('$', '600 70px Manrope, Arial, sans-serif');
  else if (k === 'jup') { g.lineWidth = 8; g.lineCap = 'round'; [[34, 3.6, 5.6], [22, 3.4, 5.8], [34, 0.5, 2.5], [22, 0.35, 2.7]].forEach(([r, a, b]) => { g.beginPath(); g.arc(64, 64, r, a, b); g.stroke(); }); }
  else if (k === 'wisp') {
    g.beginPath(); g.moveTo(64, 22); g.bezierCurveTo(84, 48, 94, 62, 94, 78); g.bezierCurveTo(94, 96, 80, 106, 64, 106); g.bezierCurveTo(48, 106, 34, 96, 34, 78);
    g.bezierCurveTo(34, 60, 52, 52, 56, 36); g.bezierCurveTo(60, 48, 66, 52, 70, 58); g.bezierCurveTo(72, 46, 70, 34, 64, 22); g.closePath(); g.fill();
    cut(() => { g.beginPath(); g.ellipse(64, 84, 11, 14, 0, 0, 7); g.fill(); });
  } else if (k === 'bonk') {
    poly([[30, 62], [36, 22], [60, 44]]); g.fill(); poly([[98, 62], [92, 22], [68, 44]]); g.fill(); g.beginPath(); g.ellipse(64, 72, 32, 28, 0, 0, 7); g.fill();
    cut(() => { g.beginPath(); g.ellipse(52, 66, 5, 5, 0, 0, 7); g.ellipse(76, 66, 5, 5, 0, 0, 7); g.ellipse(64, 84, 7, 5, 0, 0, 7); g.fill(); });
  } else { g.beginPath(); g.arc(64, 64, 22, 0, 7); g.fill(); }
}

const cache: Record<string, string> = {};
/// The token's mark: its web3icons brand mark (SVG data URL), else the drawn mark as a PNG data URL ('' where canvases are
/// unavailable). `brand: false` for tokens Veyl doesn't list (keyed by mint): a symbol anyone can pick must never borrow a
/// real token's brand mark, so they get the drawn mark.
export function tokenLogo(sym: string, { brand: useBrand = true } = {}): string {
  const key = (useBrand ? '' : '~') + sym;
  if (key in cache) return cache[key];
  const brand = useBrand ? brandLogo(sym) : null;
  if (brand) return (cache[key] = brand);
  if (typeof document === 'undefined') return '';
  const t = tokenMark(sym), S = 128, c = document.createElement('canvas'); c.width = c.height = S; const g = c.getContext('2d'); if (!g) return '';
  const bg = g.createLinearGradient(0, 0, S * 0.4, S); bg.addColorStop(0, shade(t.c, 0.15)); bg.addColorStop(1, shade(t.c, -0.2));
  g.fillStyle = bg; g.beginPath(); g.arc(64, 64, 64, 0, 7); g.fill();
  const gl = document.createElement('canvas'); gl.width = gl.height = S; const gg = gl.getContext('2d');
  if (gg) { gg.fillStyle = gg.strokeStyle = '#fff'; glyph(gg, t.g); g.drawImage(gl, 0, 0); }
  try { return (cache[key] = c.toDataURL('image/png')); } catch { return ''; }
}
