import json, os, sys; sys.path.insert(0, '.')
from common import *
BR = '/home/claude/veyl-sol/brand'; E3 = f'{BR}/explore3'; K = 'a'
def W(p, s): open(p, 'w').write(s)
def mark(fill, d): return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Veyl"><title>Veyl</title><path fill="{fill}" d="{d}"/></svg>\n'
def lock(k, mf, wf):
    vb, md, wd = lockup(k)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="Veyl"><title>Veyl</title>'
            f'<path fill="{mf}" d="{md}"/><path fill="{wf}" d="{wd}"/></svg>\n')
for k in FIN:
    W(f'{E3}/finalist-{k}.svg', mark(ROSE, d64(k)))
    W(f'{E3}/finalist-{k}-lockup.svg', lock(k, ROSE, INK))
M, S = d64(K), d32(K)
W(f'{BR}/veyl-mark.svg', mark(ROSE, M)); W(f'{BR}/veyl-mark-oxblood.svg', mark(OX, M))
W(f'{BR}/veyl-lockup.svg', lock(K, ROSE, INK)); W(f'{BR}/veyl-lockup-light.svg', lock(K, OX, DARKINK))
W(f'{BR}/veyl-mark-32grid.svg', mark(ROSE, S))
for n, c in (('white', '#FFFFFF'), ('black', '#000000'), ('currentcolor', 'currentColor')):
    W(f'{BR}/mono/veyl-mark-{n}.svg', mark(c, M)); W(f'{BR}/mono/veyl-lockup-{n}.svg', lock(K, c, c))
W(f'{BR}/mono/veyl-mark-light.svg', mark(INK, M)); W(f'{BR}/mono/veyl-mark-dark.svg', mark(DARKINK, M))
W(f'{BR}/mono/veyl-lockup-light.svg', lock(K, INK, INK)); W(f'{BR}/mono/veyl-lockup-dark.svg', lock(K, DARKINK, DARKINK))
W(f'{BR}/favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>path{fill:#7A2036}@media (prefers-color-scheme:dark){path{fill:#D88595}}</style>'
  f'<path d="{S}"/></svg>\n')
W(f'{BR}/mark-path.txt', M + '\n')

J = []
def job(html, out, w, h, t=False, full=False): J.append({'html': BASE+CSS+html, 'out': out, 'w': w, 'h': h, 'transparent': t, 'full': full})
job(f'<body style="background:transparent">{appicon(M, 512)}</body>', f'{BR}/veyl-app-icon-512.png', 512, 512, True)
job(f'<body>{appicon(M, 180, rounded=False, frac=0.56)}</body>', f'{BR}/apple-touch-icon.png', 180, 180)
job(f'<body style="background:{PAPER};display:grid;place-items:center;height:512px">{mk(M, ROSE, 400)}</body>', f'{BR}/png-mark-512-dark.png', 512, 512)
job(f'<body style="background:transparent">{mk(M, ROSE, 512)}</body>', f'{BR}/veyl-mark-512.png', 512, 512, True)
job(f'<body style="background:transparent">{mk(S, ROSE, 32)}</body>', f'{BR}/favicon-32.png', 32, 32, True)
job(f'<body>{og(K)}</body>', f'{BR}/og.png', 1200, 630)

# presentation
def sizes(d, ds, f, bg):
    return (f'<div style="display:flex;gap:22px;align-items:flex-end">{mk(d, f, 64)}{mk(ds, f, 32)}{mk(ds, f, 24)}{mk(ds, f, 16)}'
            f'{zoom(ds, f, bg, 32)}{zoom(ds, f, bg, 16)}</div>')
def runner(k):
    name = FIN[k][0]
    return (f'<div class=ru><div style="display:flex;gap:40px;align-items:center">{mk(d64(k), ROSE, 150)}{lk(k, ROSE, INK, 60)}</div>'
            f'<div style="display:flex;gap:18px;align-items:center;margin-top:28px">{appicon(d64(k), 64)}{mk(d32(k), ROSE, 24)}{mk(d32(k), ROSE, 16)}'
            f'<div style="background:{LIGHT};padding:12px;border-radius:10px;display:flex;gap:14px;align-items:center">{mk(d64(k), OX, 40)}{lk(k, OX, DARKINK, 26)}</div></div>'
            f'<p><b style="color:{INK}">Runner-up {k.upper()}: {name}.</b> {RU[k]} Files: brand/explore3/finalist-{k}.svg</p></div>')
RU = {'b': 'A crescent whose inner edge falls like cloth; the rest of the body kept as an edge.',
      'c': 'Two sheer blades settling into one point; the letterform option, strongest at 16 px.'}
html = f'''<body style="width:1600px;background:#141016;font-family:M;color:#9A8F94">
<style>.hero{{display:flex;align-items:center;gap:110px;padding:110px 120px}}.grid{{display:grid;grid-template-columns:1fr 1fr;gap:2px}}
.cell{{padding:44px 56px;display:flex;flex-direction:column;gap:28px;justify-content:center}}p{{margin:0;font-size:16px;line-height:1.55;max-width:560px}}
.ru{{background:{PAPER};padding:48px 56px}}.ru p{{margin-top:24px;color:#BFB5B9}}</style>
<div class=hero style="background:{PAPER}">{mk(M, ROSE, 380)}<div style="display:flex;flex-direction:column;gap:52px">{lk(K, ROSE, INK, 120)}
<p style="color:#BFB5B9;font-size:22px;max-width:540px">A veil drawn over a sphere. Its hem falls to a point, which is the V. Below it the body is only an edge: the liquidity is there, it just isn&#8217;t shown.</p></div></div>
<div class=hero style="background:{LIGHT};padding:80px 120px">{mk(M, OX, 240)}{lk(K, OX, DARKINK, 96)}<div style="margin-left:auto;display:flex;gap:22px">{mk(M, '#000', 84)}{mk(M, '#fff', 84, 'background:#000;padding:8px;width:100px;height:100px')}</div></div>
<div class=grid>
 <div class=cell style="background:{PAPER}">{sizes(M, S, ROSE, PAPER)}{nav(K, False)}</div>
 <div class=cell style="background:{LIGHT}">{sizes(M, S, OX, LIGHT)}{nav(K, True)}</div>
 <div class=cell style="background:#0f0b11;flex-direction:row;align-items:flex-end;gap:26px">{appicon(M, 180)}{appicon(M, 120)}{appicon(S, 76)}{appicon(S, 40)}</div>
 <div class=cell style="background:#0f0b11;padding:0;overflow:hidden;height:316px"><div style="width:600px;height:315px;margin:auto">{og(K, .5)}</div></div>
</div>
<div style="padding:40px 56px 14px;font-size:15px;color:#BFB5B9">The two other finalists, ready to swap in</div>
<div class=grid>{runner('b')}{runner('c')}</div>{ZJS}</body>'''
job(html, f'{BR}/final.png', 1600, 1000, full=True)
json.dump(J, open('jd.json', 'w'))
