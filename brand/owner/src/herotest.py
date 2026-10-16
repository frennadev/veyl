import json, sys; sys.path.insert(0, '.')
from mk import *
S = '/tmp/claude-0/-home-claude/48139b95-a25c-5b1e-a40e-8ba5bffc0ebe/scratchpad'
INK = '#EEE8EA'
V = {'C': ('#D88595', ''), 'A1': ('#B89A6E', ''),
     'A2': ('#B89A6E', '.btn.primary{background:#B89A6E;border-color:#B89A6E;color:#140d0a}'),
     'D': ('#C9C4CE', '')}
J = [{'lockup': lockup_svg(c, INK, standalone=True), 'mark': mark_svg(DM, c, standalone=True), 'css': css, 'out': f'{S}/hero-{k}.png', 'w': 1280, 'h': 720} for k, (c, css) in V.items()]
json.dump(J, open(f'{S}/hero.json', 'w'))
