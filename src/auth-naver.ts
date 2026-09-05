// Interactive helper for first-time Naver login.
// Saves session to browser-profile/ — the SINGLE persistent identity for all Naver/KIN work.
// Usage: npm run auth:naver

import { chromium, Page } from 'playwright';
import * as path from 'path';
import { checkKinSession } from './kin-search';
import { config, getNaverCredentials } from './config';

// Absolute path — must match Playwright MCP --user-data-dir in mcp-config.json
const PROFILE_DIR = path.resolve(__dirname, '../browser-profile');
const NAVER_LOGIN_URL = 'https://nid.naver.com/nidlogin.login';
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 5 * 60 * 1000;

// Fills Naver login form and submits. Credential values are never logged.
async function performNaverLogin(
  page: Page,
  creds: { id: string; password: string }
): Promise<'SUCCESS' | 'CAPTCHA' | 'FAILED'> {
  const preText = await page.evaluate(() => document.body?.innerText ?? '');
  if (preText.includes('자동입력방지') || preText.includes('보안문자')) {
    return 'CAPTCHA';
  }

  let idFilled = false;
  for (const sel of ['#id', 'input[name="id"]', 'input[placeholder*="아이디"]']) {
    try { await page.fill(sel, creds.id, { timeout: 3000 }); idFilled = true; break; } catch { /* next */ }
  }
  if (!idFilled) return 'FAILED';

  let pwFilled = false;
  for (const sel of ['#pw', 'input[name="pw"]', 'input[type="password"]']) {
    try { await page.fill(sel, creds.password, { timeout: 3000 }); pwFilled = true; break; } catch { /* next */ }
  }
  if (!pwFilled) return 'FAILED';

  // Keep the session alive across browser restarts — otherwise Naver
  // expires the login as soon as the persistent context is closed.
  try {
    const checkbox = page.locator('#loginStay').first();
    if (await checkbox.isVisible({ timeout: 1000 }) && !(await checkbox.isChecked())) {
      await checkbox.check({ timeout: 2000 });
    }
  } catch { /* best effort */ }

  let submitted = false;
  for (const sel of ['#loginBtn_row', '#loginBtn_column', '.btn_login', 'button[type="submit"]', 'input[type="submit"]']) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) {
        await el.click({ timeout: 3000 });
        submitted = true;
        break;
      }
    } catch { /* next */ }
  }
  if (!submitted) return 'FAILED';

  await page.waitForTimeout(3000);

  const url = page.url();
  const bodyText = await page.evaluate(() => document.body?.innerText ?? '');

  const captchaSignals = [
    '자동입력방지', '보안문자', 'OTP', '새로운 기기', '기기 확인',
    '기기 인증', '문자메시지', '휴대폰 번호', '전화번호 인증', '본인 확인', '추가 인증',
  ];
  if (url.includes('captcha') || url.includes('/otp/') || url.includes('challenge') ||
    captchaSignals.some(s => bodyText.includes(s))) {
    return 'CAPTCHA';
  }

  if (page.url().includes('nidlogin.login')) return 'FAILED';
  return 'SUCCESS';
}

async function authNaver() {
  console.log('[NAVER AUTH]');
  console.log('Profile:', PROFILE_DIR);
  console.log('KIN:', config.kinBaseUrl);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    args: ['--no-sandbox'],
  });

  const page = await context.newPage();

  // Navigate directly to KIN — no Naver main, no search
  const alreadyLoggedIn = await checkKinSession(page);
  if (alreadyLoggedIn) {
    console.log('[NAVER AUTH] SESSION_VALID — already logged in.');
    console.log('[NAVER AUTH] Start daily run: cat prompts/daily-run.md | claude -p');
    await context.close();
    return;
  }

  // Navigate to Naver login
  await page.goto(NAVER_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

  const creds = getNaverCredentials();
  if (creds) {
    console.log('[NAVER AUTH] .env.local credentials found — attempting auto-login...');
    const result = await performNaverLogin(page, creds);
    if (result === 'CAPTCHA') {
      console.error('[NAVER AUTH] AUTH_REQUIRES_HUMAN — CAPTCHA/OTP/device verification detected.');
      console.error('[NAVER AUTH] Please complete verification manually in the open browser window.');
    } else if (result === 'FAILED') {
      console.error('[NAVER AUTH] Auto-login failed — check NAVER_ID/NAVER_PASSWORD in .env.local.');
      console.error('[NAVER AUTH] You can also log in manually in the open browser window.');
    } else {
      console.log('[NAVER AUTH] Auto-login submitted — verifying session...');
    }
  } else {
    console.log('[NAVER AUTH] No .env.local credentials — waiting for manual login...');
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  let verified = false;

  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_INTERVAL_MS);

    const currentUrl = page.url();
    if (!currentUrl.includes('nidlogin')) {
      try {
        verified = await checkKinSession(page);
        if (verified) break;
        await page.goto(NAVER_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 10000 });
      } catch { /* keep polling */ }
    }
  }

  if (verified) {
    console.log('[NAVER AUTH] SESSION_VALID — session saved.');
    console.log('[NAVER AUTH] Profile:', PROFILE_DIR);
    console.log('[NAVER AUTH] Start daily run: cat prompts/daily-run.md | claude -p');
  } else {
    console.error('[NAVER AUTH] Login not verified within 5 minutes. Try again.');
  }

  await context.close();
}

authNaver().catch((e) => {
  console.error('[NAVER AUTH] Fatal:', e);
  process.exit(1);
});
