// A web3icons icon as an SVG data URL, for an <img>. Not the package's inline <svg> components: the icons use fixed
// gradient/clip ids (SOL__b), and inline copies on one page resolve url(#…) to the first match, which may sit in a hidden
// subtree and then paints nothing. An <img> is its own document, so its ids can't clash.
import type { TIconVariants } from '@web3icons/common';

type Node = [string, Record<string, string | number>?, Node[]?];
const KEEP = new Set(['gradientUnits', 'gradientTransform', 'viewBox']);
const attr = (k: string) => (KEEP.has(k) ? k : k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
const esc = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const svg = (nodes: Node[]): string => nodes.map(([t, a = {}, c]) =>
  `<${t}${Object.entries(a).map(([k, v]) => ` ${attr(k)}="${esc(v)}"`).join('')}>${c ? svg(c) : ''}</${t}>`).join('');

/// `background`: the brand colour as a square background, the mark in white (round it with CSS).
export function iconUrl(icon: TIconVariants, variant: 'background' | 'branded' = 'background'): string {
  const v = (icon[variant] || icon.branded) as Node[] | undefined; if (!v) return '';
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 24 24" fill="none">${svg(v)}</svg>`);
}
