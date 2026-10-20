'use client';
// Runs the pages' existing plain scripts (site/*.js) after React has hydrated the static markup, in the given order, exactly as
// the old <script src> tags at the end of <body> did. Why not <script> in the JSX: those would run while the HTML is parsed,
// before hydration, and their DOM changes would make React throw the markup away. Dynamically inserted scripts with
// async = false execute in insertion order. They only need the DOM to exist (none waits for DOMContentLoaded or load).
// Timing: each file is preloaded from <head> (ReactDOM.preload, emitted into the exported HTML), so it downloads alongside
// Next's own chunks and holds back the load event; the scripts are then inserted in the hydration commit (layout effect),
// so they run from cache right after hydration. Without the preload the downloads only started after `load`, and on a slow
// link the homepage's buttons were dead for ~200 ms after the page reported loaded (e2e/smoke.js "slow network").
// Runs once per page load (the module flag survives React's dev-only double effect).
import { useLayoutEffect } from 'react';
import { preload } from 'react-dom';

let started = false;
export default function LegacyScripts({ srcs }: { srcs: string[] }) {
  for (const src of srcs) preload(src, { as: 'script', fetchPriority: 'high' });
  useLayoutEffect(() => {
    if (started) return; started = true;
    for (const src of srcs) { const s = document.createElement('script'); s.src = src; s.async = false; document.body.appendChild(s); }
  }, [srcs]);
  return null;
}
