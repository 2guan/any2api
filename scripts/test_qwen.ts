import { chromium } from 'playwright';
import { credentialsFor } from '../apps/api/src/credentials.js';
import { db } from '../apps/api/src/db.js';

async function main() {
  const acc = db.prepare("SELECT * FROM provider_accounts WHERE provider = 'qwen' LIMIT 1").get();
  const creds = credentialsFor(acc.id);
  const rawCookie = creds.cookie || creds.token || '';

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });

  const cookies = rawCookie.split(';').map(pair => {
    const [name, ...val] = pair.trim().split('=');
    return {
      name: name.trim(),
      value: val.join('=').trim(),
      domain: '.qwen.ai',
      path: '/'
    };
  }).filter(c => c.name && c.value);

  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }

  const page = await context.newPage();

  page.on('request', req => {
    const url = req.url();
    if (url.includes('chat') || url.includes('completion') || url.includes('/api/')) {
      console.log('>> [QWEN REQ]', req.method(), url, req.postData()?.slice(0, 200));
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('completion') || url.includes('chat')) {
      console.log('<< [QWEN RES]', res.status(), url);
    }
  });

  console.log('Opening chat.qwen.ai...');
  await page.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const input = page.locator('textarea, [contenteditable="true"]').first();
  console.log('Input count:', await input.count());
  if (await input.count() > 0) {
    console.log('Typing into Qwen input...');
    await input.click();
    await page.keyboard.type('hi，你是谁？简短一句话回答', { delay: 10 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
  }

  console.log('Waiting for Qwen response...');
  await page.waitForTimeout(15000);

  const pageText = await page.evaluate(() => document.body.innerText);
  console.log('=== PAGE TEXT SNIPPET ===');
  console.log(pageText.slice(-1000));

  await browser.close();
}

main().catch(console.error);
