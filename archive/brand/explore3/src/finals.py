import sys, math; sys.path.insert(0, '.')
from lib import *
from fontTools.ttLib import TTFont
from fontTools.pens.transformPen import TransformPen

# ---------- A: Veiled orb. A veil drawn over a sphere; its hem falls to a point (the V).
# Below the hem the sphere is only an edge: the liquidity is there, it just isn't shown.
def mark_A(t=2.6, g=2.6, yp=49.5, yh=27.0):
    c = circ(32, 32, 28)
    veil = P(f'M-1 -1 H65 V{yh} C51 {yh+0.8} 37.2 {yp-13} 32 {yp} C26.8 {yp-13} 13 {yh+0.8} -1 {yh} Z')
    top = I(c, veil)
    edge = SUB(ring(32, 32, 28, t), grow(top, g))
    return U(top, edge)

# ---------- B: Eclipse fold. A crescent whose inner edge is a falling fold of cloth; the rest of the body as an edge.
def mark_B(t=2.6, g=2.6):
    c = circ(32, 32, 28)
    cut = P('M42.5 -1 C35 12 33.4 22.5 37 32 C40.6 41.5 39.6 53 33 65 L70 65 L70 -1Z')
    cres = SUB(c, cut)
    edge = SUB(ring(32, 32, 28, t), grow(cres, g))
    return U(cres, edge)

# ---------- C: Twin veils. Two sheer blades that settle into one point: a V drawn by cloth, not by a pen.
def mark_C(gap=0.0):
    a = P('M5 9 C4.4 29 14.6 45.5 31.4 58.6 C29.4 41 24.6 23.5 17.4 9 Z')
    b = P('M59 9 C59.6 29 49.4 45.5 32.6 58.6 C34.6 41 39.4 23.5 46.6 9 Z')
    return U(a, b)

FIN = {'a': ('Veiled orb', mark_A, dict(t=4.0, g=3.6, yp=48.5)),
       'b': ('Eclipse fold', mark_B, dict(t=4.0, g=3.6)),
       'c': ('Twin veils', mark_C, {})}

def d64(k): return D(FIN[k][1]())
def d32(k):  # small-size master: heavier hairline, drawn on the same 64 grid, served in a 0 0 64 64 box
    return D(FIN[k][1](**FIN[k][2]))

# ---------- wordmark: Manrope 500, outlined, lowercase
FONT = '/tmp/claude-0/-home-claude/48139b95-a25c-5b1e-a40e-8ba5bffc0ebe/scratchpad/fonts/node_modules/@fontsource/manrope/files/manrope-latin-500-normal.woff2'
KERN = {('v', 'e'): -34, ('e', 'y'): -22, ('y', 'l'): 14}
TRACK = -28
def wordmark(x0, s, weight=500):
    f = TTFont(FONT.replace('500', str(weight))); gs = f.getGlyphSet(); cm = f.getBestCmap()
    x = x0; out = pathops.Path(); prev = None
    for ch in 'veyl':
        g = gs[cm[ord(ch)]]
        if prev: x += (KERN.get((prev, ch), 0) + TRACK)*s
        p = pathops.Path(); g.draw(TransformPen(p.getPen(), (s, 0, 0, -s, x, 0)))
        out = U(out, p); x += g.width*s; prev = ch
    b = out.bounds
    return out, b

def lockup(k, markH=70.0):
    """lockup units: baseline at y=0. returns (viewBox, mark_d, word_d)"""
    s = 0.034  # font units -> lockup units (x-height 1080*s = 36.7)
    word, wb = wordmark(0, s)
    xh = 1080*s
    # mark: 64 grid scaled; optical centre on x-height middle, slightly raised
    sc = markH/64
    m = FIN[k][1]()
    mb = m.bounds
    cy = -xh/2 - 2.2
    my = cy - 32*sc
    mp = pathops.Path(); m.draw(TransformPen(mp.getPen(), (sc, 0, 0, sc, -mb[0]*sc, my)))
    mpb = mp.bounds
    gap = 0.38*markH
    wp = pathops.Path(); word.draw(TransformPen(wp.getPen(), (1, 0, 0, 1, mpb[2] + gap - wb[0], 0)))
    wpb = wp.bounds
    x0, y0 = 0, min(mpb[1], wpb[1]); x1, y1 = wpb[2], max(mpb[3], wpb[3])
    vb = f'{fmt(x0)} {fmt(y0)} {fmt(x1-x0)} {fmt(y1-y0)}'
    return vb, D(mp), D(wp)

if __name__ == '__main__':
    for k in FIN: print(k, len(d64(k)), lockup(k)[0])
