import { chromium } from 'playwright';
import { credentialsFor } from '../apps/api/src/credentials.js';
import { db } from '../apps/api/src/db.js';

async function main() {
  const acc = db.prepare("SELECT * FROM provider_accounts WHERE provider = 'kimi' LIMIT 1").get();
  const creds = credentialsFor(acc.id);
  const tok = (creds.access_token || creds.token || '').replace(/^Bearer\s+/i, '').trim();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // Log all stream and chat completion requests
  page.on('request', req => {
    const url = req.url();
    if (url.includes('stream') || url.includes('/chat') || url.includes('completion') || url.includes('service')) {
      console.log('>> [REQ]', req.method(), url, req.postData() ? req.postData().slice(0, 300) : '');
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('completion/stream') || url.includes('chat') || url.includes('segment')) {
      console.log('<< [RES]', res.status(), url);
    }
  });

  await context.addCookies([
    { name: 'access_token', value: tok, domain: '.moonshot.cn', path: '/' },
    { name: 'refresh_token', value: tok, domain: '.moonshot.cn', path: '/' },
    { name: 'token', value: tok, domain: '.moonshot.cn', path: '/' },
    { name: 'access_token', value: tok, domain: '.kimi.moonshot.cn', path: '/' },
    { name: 'refresh_token', value: tok, domain: '.kimi.moonshot.cn', path: '/' },
  ]);

  await page.addInitScript((token) => {
    localStorage.setItem('access_token', token);
    localStorage.setItem('refresh_token', token);
    localStorage.setItem('token', token);
  }, tok);

  console.log('Navigating to https://kimi.moonshot.cn...');
  await page.goto('https://kimi.moonshot.cn', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Take screenshot
  await page.screenshot({ path: '/tmp/kimi_page1.png' });

  // Locate the model dropdown trigger (bottom right of input, text containing '快速' or 'K3')
  const elements = await page.$$('button, div, span');
  let clicked = false;
  for (const el of elements) {
    const t = (await el.innerText().catch(() => '')).trim();
    if ((t === '快速' || t === 'K3' || t.startsWith('快速') || t.startsWith('K3')) && !clicked) {
      const box = await el.boundingBox();
      if (box && box.y > 200 && box.width < 200) {
        console.log('Clicking trigger:', t, box);
        await el.click().catch(() => {});
        clicked = true;
        break;
      }
    }
  }

  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/kimi_popup.png' });

  // In the menu, click K3
  console.log('Selecting K3 option...');
  const k3Option = page.locator('div, li, button').filter({ hasText: 'K3' }).filter({ hasText: '全能旗舰' }).first();
  if (await k3Option.count() > 0) {
    console.log('Found K3 element in menu, clicking it!');
    await k3Option.click();
  } else {
    console.log('Trying text="K3" click...');
    await page.getByText('K3', { exact: true }).first().click().catch(() => {});
  }

  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/kimi_k3_selected.png' });

  // Type question
  const input = page.locator('textarea, [contenteditable="true"]').first();
  if (await input.count() > 0) {
    console.log('Typing question in K3 mode...');
    await input.click();
    await page.keyboard.type('你是哪个版本的模型？详细说明一下你的模型版本与架构', { delay: 10 });
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
  }

  console.log('Waiting for response stream in K3 UI...');
  await page.waitForTimeout(18000);
  await page.screenshot({ path: '/tmp/kimi_k3_response.png' });

  const text = await page.evaluate(() => document.body.innerText);
  console.log('=== RESULT TEXT ===');
  console.log(text.slice(-1500));

  await browser.close();
}

main().catch(console.error);
