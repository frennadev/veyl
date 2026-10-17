import sys, json; sys.path.insert(0, '.')
from sketches import SK
from lib import D
ROSE, OX = '#D88595', '#7A2036'
def svg(d, fill, px): return f'<svg viewBox="0 0 100 100" width="{px}" height="{px}"><path fill="{fill}" d="{d}"/></svg>'
cells = ''
for n, name, f in SK:
    d = D(f())
    cells += (f'<div class=c><div class=dk>{svg(d, ROSE, 180)}<div class=sm>{svg(d, ROSE, 24)}{svg(d, ROSE, 16)}</div></div>'
              f'<div class=lt>{svg(d, OX, 72)}{svg(d, OX, 24)}{svg(d, OX, 16)}</div><p>{n} {name}</p></div>')
html = f'''<html><body style="margin:0;background:#141016;width:1680px;font:14px sans-serif;color:#9A8F94">
<style>.g{{display:grid;grid-template-columns:repeat(5,1fr);gap:2px}}.c{{background:#07050a}}
.dk{{height:250px;display:flex;align-items:center;justify-content:center;gap:28px;position:relative}}
.sm{{position:absolute;right:14px;bottom:14px;display:flex;gap:10px;align-items:end}}
.lt{{background:#F3EEF0;display:flex;gap:22px;align-items:center;justify-content:center;height:100px}}
p{{margin:0;padding:10px 14px}}</style><div class=g>{cells}</div></body></html>'''
out = sys.argv[1]
json.dump([{'html': html, 'out': out, 'w': 1680, 'h': 400, 'full': True}], open('j.json', 'w'))
