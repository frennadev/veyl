'use client';
// The old docs.html inline script, unchanged in behaviour: highlights the table-of-contents link of the section in view (and
// scrolls the horizontal mobile TOC to it), and gives the sticky nav its border once the page scrolls. It only toggles
// classes on markup React rendered and never re-renders, so React and these listeners do not fight.
import { useEffect } from 'react';

export default function DocsEffects() {
  useEffect(() => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('.toc a[href^="#"]'));
    const secs = links.map((a) => document.querySelector<HTMLElement>(a.getAttribute('href')!));
    let last = -1;
    const toc = () => {
      const y = window.scrollY + (window.innerWidth <= 900 ? 160 : 120); let cur = 0;
      secs.forEach((s, i) => { if (s && s.offsetTop <= y) cur = i; });
      links.forEach((a, i) => a.classList.toggle('active', i === cur));
      const t = document.querySelector<HTMLElement>('.toc'), a = links[cur];
      if (a && t && t.scrollWidth > t.clientWidth && last !== cur) { last = cur; t.scrollTo({ left: t.scrollLeft + a.getBoundingClientRect().left - t.getBoundingClientRect().left - 16, behavior: 'smooth' }); }
    };
    const nav = document.getElementById('nav');
    const scrolled = () => nav?.classList.toggle('scrolled', window.scrollY > 8);
    toc(); scrolled();
    window.addEventListener('scroll', toc, { passive: true }); window.addEventListener('scroll', scrolled, { passive: true });
    return () => { window.removeEventListener('scroll', toc); window.removeEventListener('scroll', scrolled); };
  }, []);
  return null;
}
