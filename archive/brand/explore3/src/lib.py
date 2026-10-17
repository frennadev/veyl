import math, pathops
from fontTools.svgLib.path import parse_path
from fontTools.pens.svgPathPen import SVGPathPen

def fmt(v):
    s = f'{v:.3f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s

def P(d):
    p = pathops.Path(); pen = p.getPen(); parse_path(d, pen); return p

def D(p):
    sp = SVGPathPen(None, ntos=fmt); p.draw(sp); return sp.getCommands()

def op(a, b, o):
    return pathops.op(a, b, o, fix_winding=True)
def U(*ps):
    r = ps[0]
    for p in ps[1:]: r = op(r, p, pathops.PathOp.UNION)
    return r
def SUB(a, *bs):
    for b in bs: a = op(a, b, pathops.PathOp.DIFFERENCE)
    return a
def X(a, b): return op(a, b, pathops.PathOp.XOR)
def I(a, b): return op(a, b, pathops.PathOp.INTERSECTION)

K = 0.5522847498
def circ(cx, cy, r):
    k = r*K
    return P(f'M{cx+r} {cy} C{cx+r} {cy+k} {cx+k} {cy+r} {cx} {cy+r} C{cx-k} {cy+r} {cx-r} {cy+k} {cx-r} {cy} '
             f'C{cx-r} {cy-k} {cx-k} {cy-r} {cx} {cy-r} C{cx+k} {cy-r} {cx+r} {cy-k} {cx+r} {cy} Z')
def ring(cx, cy, r, t): return SUB(circ(cx, cy, r), circ(cx, cy, r-t))

def stroke(p, w, cap='butt', join='miter'):
    q = pathops.Path(p)
    caps = {'butt': pathops.LineCap.BUTT_CAP, 'round': pathops.LineCap.ROUND_CAP, 'square': pathops.LineCap.SQUARE_CAP}
    joins = {'miter': pathops.LineJoin.MITER_JOIN, 'round': pathops.LineJoin.ROUND_JOIN, 'bevel': pathops.LineJoin.BEVEL_JOIN}
    q.stroke(w, caps[cap], joins[join], 4); q.convertConicsToQuads()
    return U(q, pathops.Path())  # normalise winding

def grow(p, g):  # outset by g (round)
    return U(p, stroke(p, 2*g, 'round', 'round'))

def rect(x0, y0, x1, y1): return P(f'M{x0} {y0}H{x1}V{y1}H{x0}Z')
def poly(*pts): return P('M' + ' L'.join(f'{x} {y}' for x, y in pts) + 'Z')

def lens(ax, ay, bx, by, bl, br=None, t=0.36):
    """almond from A to B; bl/br = bulge to left/right of A->B direction (as fraction of length)."""
    br = bl if br is None else br
    dx, dy = bx-ax, by-ay; L = math.hypot(dx, dy); nx, ny = -dy/L, dx/L
    def ctrl(f, s):
        return (ax+dx*f+nx*s*L, ay+dy*f+ny*s*L)
    c1, c2 = ctrl(t, bl), ctrl(1-t, bl); c3, c4 = ctrl(1-t, -br), ctrl(t, -br)
    return P(f'M{ax} {ay} C{c1[0]} {c1[1]} {c2[0]} {c2[1]} {bx} {by} C{c3[0]} {c3[1]} {c4[0]} {c4[1]} {ax} {ay}Z')
