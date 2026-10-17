"""Small exact-ish geometry kit for the Veyl mark: piecewise cubic curves, offsets, x-splitting."""
import numpy as np

def fmt(v):
    s = f'{v:.3f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s

def bez(P, t):
    P = np.asarray(P, float); t = np.asarray(t, float)[..., None]
    return ((1-t)**3)*P[0] + 3*((1-t)**2)*t*P[1] + 3*(1-t)*t*t*P[2] + t**3*P[3]

def dbez(P, t):
    P = np.asarray(P, float); t = np.asarray(t, float)[..., None]
    return 3*((1-t)**2)*(P[1]-P[0]) + 6*(1-t)*t*(P[2]-P[1]) + 3*t*t*(P[3]-P[2])

def split(P, t):
    P = [np.asarray(p, float) for p in P]
    a = P[0]+(P[1]-P[0])*t; b = P[1]+(P[2]-P[1])*t; c = P[2]+(P[3]-P[2])*t
    d = a+(b-a)*t; e = b+(c-b)*t; m = d+(e-d)*t
    return [P[0], a, d, m], [m, e, c, P[3]]

def t_at_x(P, x):
    lo, hi = 0.0, 1.0
    x0 = bez(P, 0)[0]; x1 = bez(P, 1)[0]
    inc = x1 > x0
    for _ in range(60):
        mid = (lo+hi)/2
        if (bez(P, mid)[0] < x) == inc: lo = mid
        else: hi = mid
    return (lo+hi)/2

def offset_fit(P, dist):
    """Offset a cubic by dist along its left normal (y-down: positive dist moves 'down' for left->right curves)."""
    P = np.asarray(P, float)
    ts = np.linspace(0, 1, 41)
    pts = bez(P, ts); der = dbez(P, ts)
    nrm = np.stack([-der[:, 1], der[:, 0]], 1); nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)

    Q = pts + dist*nrm
    A, B = Q[0], Q[-1]
    tA = der[0]/np.linalg.norm(der[0]); tB = der[-1]/np.linalg.norm(der[-1])
    # chord-length params
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(Q, axis=0), axis=1))]); u = L/L[-1]
    b0 = (1-u)**3; b1 = 3*(1-u)**2*u; b2 = 3*(1-u)*u*u; b3 = u**3
    R = Q - np.outer(b0+b1, A) - np.outer(b2+b3, B)
    M = np.stack([np.concatenate([b1*tA[0], b1*tA[1]]), np.concatenate([-b2*tB[0], -b2*tB[1]])], 1)
    rhs = np.concatenate([R[:, 0], R[:, 1]])
    (la, lb), *_ = np.linalg.lstsq(M, rhs, rcond=None)
    return [A, A+la*tA, B-lb*tB, B]

class Curve:
    """Piecewise cubic, monotone in x (left->right)."""
    def __init__(self, segs): self.segs = [[np.asarray(p, float) for p in s] for s in segs]
    def offset(self, d): return Curve([offset_fit(s, d) for s in self.segs])
    def y(self, x):
        for s in self.segs:
            if s[0][0] <= x <= s[3][0]: return float(bez(s, t_at_x(s, x))[1])
        raise ValueError(x)
    def between(self, x0, x1):
        """sub-curve segments from x0 to x1 (x0<x1), as list of cubics."""
        out = []
        for s in self.segs:
            a, b = s[0][0], s[3][0]
            if b <= x0 or a >= x1: continue
            seg = s
            if x0 > a:
                seg = split(seg, t_at_x(seg, x0))[1]
            if x1 < b:
                seg = split(seg, t_at_x(seg, x1))[0]
            out.append(seg)
        return out

def cto(seg): return 'C' + ' '.join(f'{fmt(p[0])} {fmt(p[1])}' for p in seg[1:])
def rev(segs): return [[s[3], s[2], s[1], s[0]] for s in reversed(segs)]
def path_curve(segs): return ' '.join(cto(s) for s in segs)

def corner(x0, y0, x1, y1, cx, cy, k=0.86):
    """smooth corner from (x0,y0) to (x1,y1) about corner point (cx,cy); k = handle fraction (0.55 ~ circle, higher = squarer)."""
    return f'C{fmt(x0+(cx-x0)*k)} {fmt(y0+(cy-y0)*k)} {fmt(x1+(cx-x1)*k)} {fmt(y1+(cy-y1)*k)} {fmt(x1)} {fmt(y1)}'
