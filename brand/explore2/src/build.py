import sys, os, json, subprocess
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.basePen import AbstractPen
from final_mark import master, M64, M32
from geo import fmt

BR = '/home/claude/veyl-sol/brand'
ROSE, OX, INK, DARKINK, PAPER = '#D88595', '#7A2036', '#EEE8EA', '#1A1418', '#07050a'
FONT = f'{HERE}/fonts/fontsource-instrument-sans-5.3.0/package/files/instrument-sans-latin-500-normal.woff2'

# ---------- wordmark ----------
U = 0.1                     # 1 font unit = 0.1 lockup unit; l ascender = 72
MARK = 72                   # mark height = ascender height; bin width = 72*7.6/50 = 10.944
BIN = MARK*7.6/50
GAP = 24.5                 # mark -> wordmark space
KERN = {('v', 'e'): -16, ('e', 'y'): -12, ('y', 'l'): 4}
TRACK = -4

class Widen(AbstractPen):
    """widen the l stem symmetrically so it equals one bin of the mark."""
    def __init__(self, pen, cx, half): self.p, self.cx, self.h = pen, cx, half
    def _m(self, pt): return ((self.cx - self.h) if pt[0] < self.cx else (self.cx + self.h), pt[1])
    def moveTo(self, pt): self.p.moveTo(self._m(pt))
    def lineTo(self, pt): self.p.lineTo(self._m(pt))
    def curveTo(self, *pts): self.p.curveTo(*map(self._m, pts))
    def qCurveTo(self, *pts): self.p.qCurveTo(*map(self._m, pts))
    def closePath(self): self.p.closePath()
    def endPath(self): self.p.endPath()

def wordmark(x0):
    f = TTFont(FONT); gs = f.getGlyphSet()
    x = x0; ds = []; prev = None
    for ch in 'veyl':
        if prev: x += (KERN.get((prev, ch), 0) + TRACK)*U
        sp = SVGPathPen(gs, ntos=fmt)
        tp = TransformPen(sp, (U, 0, 0, -U, x, 0))
        pen = Widen(tp, 125, BIN/U/2) if ch == 'l' else tp
        gs[ch].draw(pen)
        ds.append(sp.getCommands())
        x += gs[ch].width*U
        prev = ch
    right = x - (250 - 125 - BIN/U/2)*U  # tight right edge at l stem
    return ' '.join(ds), right

MARK_D = master(X=0, Y=-MARK, S=MARK)
WORD_D, RIGHT = wordmark(MARK + GAP - 11*U)   # v has 11u left bearing; optical start
VB = f'0 {-MARK} {fmt(RIGHT)} {fmt(MARK + 20.5)}'

def lockup(mark_fill, word_fill, title=True):
    t = '<title>Veyl</title>' if title else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VB}" role="img" aria-label="Veyl">{t}'
            f'<path fill="{mark_fill}" d="{MARK_D}"/><path fill="{word_fill}" d="{WORD_D}"/></svg>\n')

def mark(fill, d=M64, vb='0 0 64 64'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="Veyl"><title>Veyl</title><path fill="{fill}" d="{d}"/></svg>\n'

def W(p, s): open(f'{BR}/{p}', 'w').write(s)

if __name__ == '__main__':
    os.makedirs(f'{BR}/mono', exist_ok=True)
    W('veyl-mark.svg', mark(ROSE))
    W('veyl-mark-oxblood.svg', mark(OX))
    W('veyl-lockup.svg', lockup(ROSE, INK))
    W('veyl-lockup-light.svg', lockup(OX, DARKINK))
    for name, c in (('white', '#FFFFFF'), ('black', '#000000'), ('currentcolor', 'currentColor')):
        W(f'mono/veyl-mark-{name}.svg', mark(c))
        W(f'mono/veyl-lockup-{name}.svg', lockup(c, c))
    W('mono/veyl-mark-light.svg', mark(INK)); W('mono/veyl-mark-dark.svg', mark(DARKINK))
    W('mono/veyl-lockup-light.svg', lockup(INK, INK)); W('mono/veyl-lockup-dark.svg', lockup(DARKINK, DARKINK))
    W('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>path{fill:#7A2036}@media (prefers-color-scheme:dark){path{fill:#D88595}}</style>'
      f'<path d="{M32}"/></svg>\n')
    W('veyl-mark-32grid.svg', mark(ROSE, M32, '0 0 32 32'))
    W('mark-path.txt', M64 + '\n')
    json.dump({'MARK_D': MARK_D, 'WORD_D': WORD_D, 'VB': VB, 'M64': M64, 'M32': M32}, open(f'{HERE}/built.json', 'w'))
    print(VB)
