import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:5173/zone', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

// ── Step 1: diagnose Quai de la Rapée ──
await page.fill('input[type="search"], input[placeholder*="adresse"]', 'Quai de la Rapée 75012 Paris');
await page.waitForTimeout(1500);
await page.locator('li').first().click().catch(() => {});
await page.waitForTimeout(800);
await page.getByRole('button', { name: /Diagnostiquer/i }).click().catch(() => {});
await page.waitForTimeout(12000);
await page.screenshot({ path: '../docs/screenshots/step1-diagnostic.png' });
console.log('step1 ok');

// ── Step 2: scenario panel + water ──
await page.getByRole('button', { name: /Étape suivante/i }).click().catch(() => {});
await page.waitForTimeout(10000);
await page.screenshot({ path: '../docs/screenshots/step2-scenario.png' });
console.log('step2 ok');

// scrub the timeline to mid-day to show water
const slider = page.locator('input[type="range"]').first();
const n = await slider.count();
console.log('sliders:', n);
if (n) {
  await slider.fill('720').catch(e => console.log('fill err', e.message));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '../docs/screenshots/step2-water.png' });
  console.log('water ok');
}

await browser.close();
