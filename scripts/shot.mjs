// Dev aid: screenshots the running app. Usage: node scripts/shot.mjs <url> <out.png> [actions.json]
import { chromium } from 'playwright-core';
const [url, out, actions] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const logs = [];
page.on('dialog', (d) => d.accept());
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => document.querySelector('.status')?.textContent && !document.querySelector('.busy'), null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(800);
if (actions) {
  for (const a of JSON.parse(actions)) {
    if (a.click) await page.click(a.click);
    if (a.mouse) await page.mouse.click(a.mouse[0], a.mouse[1], a.opts ?? {});
    if (a.dbl) await page.mouse.dblclick(a.dbl[0], a.dbl[1]);
    if (a.drag) { await page.mouse.move(...a.drag[0]); await page.mouse.down(); for (const p of a.drag.slice(1)) await page.mouse.move(p[0], p[1], { steps: 5 }); await page.mouse.up(); }
    if (a.key) await page.keyboard.press(a.key);
    if (a.wait) await page.waitForTimeout(a.wait);
    if (a.waitGen) { await page.waitForTimeout(400); await page.waitForFunction(() => !document.querySelector('.busy'), null, { timeout: 30000 }); await page.waitForTimeout(300); }
    if (a.shot) await page.screenshot({ path: a.shot });
  }
}
await page.screenshot({ path: out });
console.log(logs.filter((l) => !l.includes('[vite]') && !l.includes('React DevTools')).join('\n'));
await browser.close();
