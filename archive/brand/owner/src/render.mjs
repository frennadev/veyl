// node render2.mjs jobs.json  -> [{html, out, w, h, transparent}]
import { chromium } from '/tmp/claude-0/-home-claude/48139b95-a25c-5b1e-a40e-8ba5bffc0ebe/scratchpad/pw/node_modules/playwright/index.mjs';
import fs from 'fs';
const jobs = JSON.parse(fs.readFileSync(process.argv[2]));
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const j of jobs) {
  const p = await b.newPage({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: j.dpr || 1 });
  await p.setContent(j.html, { waitUntil: 'load' }); await p.waitForTimeout(250);
  await p.screenshot({ path: j.out, omitBackground: !!j.transparent, fullPage: !!j.full });
  await p.close();
}
await b.close();
