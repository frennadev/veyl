// The Veyl ghost, drawn from its traced parts (lib/ghost.ts) instead of an <img>, so the page can move it: the eyes sit in
// their own group (.g-eyes, offset by --ex/--ey) and each eye in its own (.g-eye) so a blink can squash it. `id` keeps the
// gradient ids unique when the page shows more than one ghost. Decorative by default; pass `label` to name it.
import { GHOST } from '@/lib/ghost';

export default function Ghost({ id, className = 'ghost', label }: { id: string; className?: string; label?: string }) {
  const b = `${id}-b`, h = `${id}-h`;
  return (
    <svg className={className} viewBox={GHOST.box.join(' ')} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <defs>
        <linearGradient id={b} gradientUnits="userSpaceOnUse" x1="520" y1="520" x2="650" y2="720"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#a2a2a2" /></linearGradient>
        <linearGradient id={h} gradientUnits="userSpaceOnUse" x1="480" y1="300" x2="440" y2="590"><stop offset="0" stopColor="#000" /><stop offset=".45" stopColor="#090909" /><stop offset="1" stopColor="#474747" /></linearGradient>
      </defs>
      <path className="g-sil" d={GHOST.sil} fill="#fff" />
      <path d={GHOST.body} fill={`url(#${b})`} />
      <path d={GHOST.hood} fill={`url(#${h})`} />
      <g className="g-eyes">
        {GHOST.eyes.map((e, i) => (
          <g className="g-eye" key={i}><ellipse cx={e.cx} cy={e.cy} rx={e.rx} ry={e.ry} transform={`rotate(${e.a} ${e.cx} ${e.cy})`} fill="#fff" /></g>
        ))}
      </g>
    </svg>
  );
}
