// node hero.mjs jobs.json -> [{lockup, mark, css, out, w, h, page}] renders the real site page with brand files swapped in
import { chromium } from '/tmp/claude-0/-home-claude/48139b95-a25c-5b1e-a40e-8ba5bffc0ebe/scratchpad/pw/node_modules/playwright/index.mjs';
import fs from 'fs';
const jobs = JSON.parse(fs.readFileSync(process.argv[2]));
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const j of jobs) {
  const p = await b.newPage({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: j.dpr || 1 });
  await p.route('**/brand/veyl-lockup.svg', (r) => r.fulfill({ contentType: 'image/svg+xml', body: j.lockup }));
  await p.route('**/brand/veyl-mark.svg', (r) => r.fulfill({ contentType: 'image/svg+xml', body: j.mark }));
  await p.route(/^https?:\/\//, (r) => r.abort());
  await p.goto('file:///home/claude/veyl-sol/site/' + (j.page || 'index.html'), { waitUntil: 'load' }).catch(() => {});
  if (j.fonts) await p.addStyleTag({ content: j.fonts }); if (j.css) await p.addStyleTag({ content: j.css }); await p.evaluate(() => document.fonts.ready);
  await p.addStyleTag({ content: '*{animation:none!important;transition:none!important}.layer{opacity:1!important}' });
  await p.waitForTimeout(600);
  await p.screenshot({ path: j.out });
  await p.close();
}
await b.close();
