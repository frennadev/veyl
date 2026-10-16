import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from geo import *

def pane(center, X=7, Y=7, W=50, H=50, Rt=13, Rb=6, kt=0.84, kb=0.84, g=3.0, n=5, widths=None, gaps=None):
    """Returns compound path d: a soft-topped pane cut by a veil line (center curve) and n-1 vertical gaps."""
    up = center.offset(-g/2); lo = center.offset(g/2)
    R = X+W; B = Y+H
    yl, yr = up.y(X), up.y(R)
    d = [f'M{fmt(X)} {fmt(yl)} V{fmt(Y+Rt)}', corner(X, Y+Rt, X+Rt, Y, X, Y, kt), f'H{fmt(R-Rt)}',
         corner(R-Rt, Y, R, Y+Rt, R, Y, kt), f'V{fmt(yr)}', path_curve(rev(up.between(X, R))), 'Z']
    # bins
    if gaps is None: gaps = [g]*(n-1)
    if widths is None:
        bw = (W - sum(gaps))/n; widths = [bw]*n
    x = X
    for i in range(n):
        x0, x1 = x, x+widths[i]
        segs = lo.between(x0, x1)
        d.append(f'M{fmt(x0)} {fmt(lo.y(x0))} {path_curve(segs)}')
        if i == n-1:
            d += [f'V{fmt(B-Rb)}', corner(R, B-Rb, R-Rb, B, R, B, kb)]
        else:
            d.append(f'V{fmt(B)}')
        if i == 0:
            d += [f'H{fmt(X+Rb)}', corner(X+Rb, B, X, B-Rb, X, B, kb), 'Z']
        else:
            d += [f'H{fmt(x0)}', 'Z']
        if i < n-1: x = x1 + gaps[i]
    return ' '.join(d)

def svg(d, vb='0 0 64 64', fill='currentColor', extra=''):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"><path fill="{fill}" d="{d}"/>{extra}</svg>'

def flap_curve(yL=21, yC=41, X=7, W=50, a=0.30, b=0.62, ext=3):
    """Swag/flap: two cubics meeting at centre with horizontal tangent. a: how far the sides' handle runs along the slope;
    b: how wide the bottom rounding is (fraction of half width)."""
    hw = W/2; cx = X+hw
    xl = X-ext; yl = yL - (yC-yL)*ext/hw*1.2
    s1 = [(xl, yl), (xl + hw*a, yl + (yC-yl)*a*1.5), (cx - hw*b, yC), (cx, yC)]
    s2 = [(cx, yC), (cx + hw*b, yC), (X+W+ext - hw*a, yl + (yC-yl)*a*1.5), (X+W+ext, yl)]
    return Curve([s1, s2])

def drape_curve(yL=20, yR=44, X=7, W=50, ext=3, a=0.42):
    xl, xr = X-ext, X+W+ext
    return Curve([[(xl, yL), (xl + (xr-xl)*a, yL), (xr - (xr-xl)*a, yR), (xr, yR)]])

def spot_curve(yS=33, yT=17, X=7, W=50, ext=3, b=0.42):
    hw = W/2; cx = X+hw
    s1 = [(X-ext, yS), (X+hw*0.42, yS), (cx-hw*b*0.75, yT), (cx, yT)]
    s2 = [(cx, yT), (cx+hw*b*0.75, yT), (X+W-hw*0.42, yS), (X+W+ext, yS)]
    return Curve([s1, s2])

if __name__ == '__main__':
    OUT = '/home/claude/veyl-sol/brand/explore2/r4'; os.makedirs(OUT, exist_ok=True)
    S = {}
    S['F1'] = ('Flap · 5', 'soft V flap, 5 bins', svg(pane(flap_curve())))
    S['F2'] = ('Flap · 4', 'V point lands on a gap', svg(pane(flap_curve(), n=4)))
    S['F3'] = ('Flap · 5 deep', 'deeper, tighter V', svg(pane(flap_curve(yL=19, yC=44, b=0.45), Rb=5)))
    S['F4'] = ('Flap · 3', 'favicon-weight study', svg(pane(flap_curve(yL=20, yC=42, b=0.5), n=3, g=4.2)))
    S['D1'] = ('Drape · 5', 'veil drawn across', svg(pane(drape_curve(), Rt=12)))
    S['D2'] = ('Drape · 4', '', svg(pane(drape_curve(yL=19, yR=45, a=0.5), Rt=12, n=4)))
    S['S1'] = ('Spot · 5', 'veil over the bell', svg(pane(spot_curve())))
    json.dump(S, open(OUT+'/index.json', 'w'))
