import json, os
H = os.path.dirname(os.path.abspath(__file__))
B = json.load(open(f'{H}/built.json'))
BR = '/home/claude/veyl-sol/brand'
FONTDIR = f'{H}/fonts/fontsource-instrument-sans-5.3.0/package/files'
M64, M32 = B['M64'], B['M32']
ROSE, OX, INK, DARKINK = '#D88595', '#7A2036', '#EEE8EA', '#1A1418'

def mk(fill, size, d=M64, vb='0 0 64 64', style=''):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{size}" height="{size}" style="display:block;{style}"><path fill="{fill}" d="{d}"/></svg>'

def lock(mf, wf, h):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{B["VB"]}" height="{h}" style="display:block;overflow:visible"><path fill="{mf}" d="{B["MARK_D"]}"/><path fill="{wf}" d="{B["WORD_D"]}"/></svg>'

import base64
def _f(w): return 'data:font/woff2;base64,'+base64.b64encode(open(f'{FONTDIR}/instrument-sans-latin-{w}-normal.woff2','rb').read()).decode()
BASE = (f'<style>@font-face{{font-family:IS;src:url({_f(400)});font-weight:400}}'
        f'@font-face{{font-family:IS;src:url({_f(500)});font-weight:500}}'
        '*{box-sizing:border-box}html,body{margin:0}</style>')
ICONBG = 'radial-gradient(120% 90% at 30% 0%, #241a27 0%, #120d15 45%, #07050a 100%)'

def appicon(px, rounded=True, mark_frac=0.56):
    r = f'border-radius:{px*0.2237:.2f}px;' if rounded else ''
    edge = (f'box-shadow:inset 0 0 0 {max(1, px/256):.2f}px rgba(255,255,255,.07), inset 0 {px/128:.2f}px 0 rgba(255,255,255,.05);'
            if rounded else '')
    return (f'<div style="width:{px}px;height:{px}px;{r}background:{ICONBG};display:grid;place-items:center;{edge}">'
            f'{mk(ROSE, px*mark_frac*64/50)}</div>')

def jobs():
    J = []
    def job(html, out, w, h, t=False):
        J.append({'html': BASE+html, 'out': out, 'w': w, 'h': h, 'transparent': t})
    job(f'<body style="background:transparent">{appicon(512)}</body>', f'{BR}/veyl-app-icon-512.png', 512, 512, True)
    job(f'<body>{appicon(180, rounded=False, mark_frac=0.54)}</body>', f'{BR}/apple-touch-icon.png', 180, 180)
    job(f'<body style="background:#07050a">{mk(ROSE, 512)}</body>', f'{BR}/png-mark-512-dark.png', 512, 512)
    job(f'<body style="background:transparent">{mk(ROSE, 512)}</body>', f'{BR}/veyl-mark-512.png', 512, 512, True)
    job(f'<body style="background:transparent">{mk(ROSE, 32, M32, "0 0 32 32")}</body>', f'{BR}/favicon-32.png', 32, 32, True)
    og = f'''<body style="width:1200px;height:630px;background:#07050a;position:relative;overflow:hidden;font-family:IS">
<div style="position:absolute;inset:0;background:radial-gradient(60% 85% at 84% 50%, rgba(122,32,54,.30), rgba(7,5,10,0) 70%)"></div>
<div style="position:absolute;right:-96px;top:50%;transform:translateY(-50%)">{mk('#7A2036', 620)}</div>
<div style="position:absolute;left:96px;top:232px">{lock(ROSE, INK, 104)}</div>
<div style="position:absolute;left:98px;top:380px;color:#BFB5B9;font-size:32px;font-weight:400;letter-spacing:-.005em">Private DLMM liquidity on Solana</div>
</body>'''
    job(og, f'{BR}/og.png', 1200, 630)
    return J

if __name__ == '__main__':
    json.dump(jobs(), open(f'{H}/jobs.json', 'w'))
