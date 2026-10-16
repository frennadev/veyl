import json, sys; sys.path.insert(0, '.'); sys.path.insert(0, '/home/claude/veyl-sol/brand/explore3/src')
from geo import *
from common import BASE, ZJS
S = '/tmp/claude-0/-home-claude/48139b95-a25c-5b1e-a40e-8ba5bffc0ebe/scratchpad'
GOLD, PAPER = '#B89A6E', '#07050a'
def zoom(d, fill, bg, sz, big=120):
    s = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="{fill}" d="{d}"/></svg>'
    return f'<div style="text-align:center;font:12px sans-serif;color:#888"><canvas class=z data-s=\'{s}\' data-sz="{sz}" data-bg="{bg}" style="width:{big}px;height:{big}px;image-rendering:pixelated"></canvas><br>{sz}px</div>'
C = {'M  master (5 pills, true cut)': D(fit(master(), pad=3)[0]),
     'P5 5 pills 2px/1px, cut 1.1px': D(snapped(5, 8, 4, 4, 4.5)),
     'P5b 5 pills 2px/1px, cut 1.4px': D(snapped(5, 8, 4, 4, 5.6)),
     'P4 4 pills 3px/1px, cut 1.1px': D(snapped(4, 12, 4, 4, 4.5)),
     'P4c 4 pills centred, cut 1.25px': D(snapped(4, 12, 4, 2, 5.0))}
rows = ''
for k, d in C.items():
    cells = ''.join(zoom(d, GOLD, PAPER, s) for s in (16, 24, 32)) + ''.join(zoom(d, '#7A2036', '#F3EEF0', s) for s in (16, 24))
    rows += f'<div style="display:flex;gap:18px;align-items:center;margin:10px 0"><div style="width:200px;color:#ccc;font:14px sans-serif">{k}</div>{cells}</div>'
json.dump([{'html': BASE + f'<body style="background:#1a1a1a;padding:20px;width:900px">{rows}{ZJS}</body>', 'out': f'{S}/small-test.png', 'w': 900, 'h': 760}], open(f'{S}/sm.json', 'w'))
json.dump(C, open(f'{S}/small-d.json', 'w'))
