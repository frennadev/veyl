"""Owner's mark, rebuilt as exact geometry from measurements of the supplied raster (1254 px square).
Measured (source px): pill width 152.5, pitch 174 (gap 21.5), ends are full semicircles (r = w/2);
pill tops rise 65.9 per pitch (600 -> 335), pill bottoms rise 56.2 per pitch (1013 -> 786), so each pill is 9.7 taller
than the one before; one straight cut, slope -0.3904 (21.3 deg), 25.6 vertical / 23.8 perpendicular, centre line
y = -0.3904 x + 929.5. Raster wobble removed: the cut is one straight band, every pill shares width/pitch, rises are linear."""
import math, sys, pathops
sys.path.insert(0, '/home/claude/veyl-sol/brand/explore3/src')
from lib import P, D, U, SUB, rect, poly, fmt
from fontTools.pens.transformPen import TransformPen

SRC = dict(x0=203.25, w=152.5, pitch=174.0, top0=600.2, trise=65.9, bot0=1013.0, brise=56.2,
           slope=-0.3904, c0=929.5, vgap=25.6)

def pill(x, top, bot, w):
    r = w / 2; k = r * 0.5522847498
    return P(f'M{x} {top+r} C{x} {top+r-k} {x+r-k} {top} {x+r} {top} C{x+r+k} {top} {x+w} {top+r-k} {x+w} {top+r} '
             f'L{x+w} {bot-r} C{x+w} {bot-r+k} {x+r+k} {bot} {x+r} {bot} C{x+r-k} {bot} {x} {bot-r+k} {x} {bot-r} Z')

def build(n=5, x0=None, w=None, pitch=None, top0=None, trise=None, bot0=None, brise=None, slope=None, c0=None, vgap=None, first=0):
    """pills i = first .. first+n-1 of the measured sequence; the cut band subtracted (true negative space)."""
    p = dict(SRC); p.update({k: v for k, v in dict(x0=x0, w=w, pitch=pitch, top0=top0, trise=trise, bot0=bot0, brise=brise,
                                                     slope=slope, c0=c0, vgap=vgap).items() if v is not None})
    body = pathops.Path()
    for i in range(first, first + n):
        x = p['x0'] + i * p['pitch']
        body = U(body, pill(x, p['top0'] - i * p['trise'], p['bot0'] - i * p['brise'], p['w']))
    X0, X1 = p['x0'] - 50, p['x0'] + (first + n) * p['pitch'] + 50
    y = lambda x, off: p['slope'] * x + p['c0'] + off
    h = p['vgap'] / 2
    band = poly((X0, y(X0, -h)), (X1, y(X1, -h)), (X1, y(X1, h)), (X0, y(X0, h)))
    return SUB(body, band), p

def fit(path, box=64, pad=4, cy_bias=0.0):
    """scale/centre a source-space path into a box x box viewBox, mark width = box - 2*pad (or height limits)."""
    b = path.bounds; bw, bh = b[2]-b[0], b[3]-b[1]
    s = min((box - 2*pad) / bw, (box - 2*pad) / bh)
    tx = box/2 - (b[0]+bw/2)*s; ty = box/2 - (b[1]+bh/2)*s + cy_bias
    q = pathops.Path(); path.draw(TransformPen(q.getPen(), (s, 0, 0, s, tx, ty)))
    return q, (s, tx, ty)

def master():
    m, _ = build(); return m

# ---- small-size masters (drawn on a 32 grid, served in 0 0 64 64 like the master) ----
def small5(cut=None):
    # 5 pills, cut thickened so it is >= 1 device px at 24 px
    p = dict(SRC); vg = cut or p['vgap'] * 2.0
    m, _ = build(vgap=vg); return m
def small4(cut=None):
    # 4 pills (drop the first), wider pills relative to the box, cut thickened; same rise and slope
    vg = cut or SRC['vgap'] * 1.9
    m, _ = build(n=4, first=1, vgap=vg); return m

def snapped(n, w, gap, x0, vgap, H0=None):
    """pixel-snapped small master in the 0 0 64 64 grid (4 units = 1 px at 16 px). Pill proportions, rises and the cut's
    slope and position are carried over from the measured mark; only width/gap/cut thickness are snapped."""
    pitch = w + gap; k = pitch / SRC['pitch']               # units per source px along x
    first = 5 - n                                           # a 4-pill version drops the lowest (first) pill
    srcH0 = (SRC['bot0'] - first*SRC['brise']) - (SRC['top0'] - first*SRC['trise'])
    h0 = srcH0 / SRC['w'] * w if H0 is None else H0         # first pill's height keeps its width:height ratio
    trise, brise = SRC['trise']*k, SRC['brise']*k
    # vertical layout: bbox from top of last pill to bottom of first pill, centred in 64
    bbh = h0 + (n-1)*trise
    top0 = 32 - bbh/2 + (n-1)*trise; bot0 = top0 + h0
    # cut: same slope; passes each pill at the same fraction of its height as in the source
    sx = SRC['x0'] + first*SRC['pitch'] + SRC['w']/2; sy = SRC['slope']*sx + SRC['c0']
    frac = (sy - (SRC['top0'] - first*SRC['trise'])) / srcH0
    cx = x0 + w/2; cy = top0 + frac*h0
    c0 = cy - SRC['slope']*cx
    m, _ = build(n=n, x0=x0, w=w, pitch=pitch, top0=top0 + 0*trise, trise=trise, bot0=bot0, brise=brise, slope=SRC['slope'], c0=c0, vgap=vgap)
    return m
