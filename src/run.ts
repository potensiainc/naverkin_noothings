// Auth setup entry point.
// Verifies Naver KIN session using the persistent browser profile.
// The daily run orchestration is in prompts/daily-run.md — run via Claude Code Agent.

import { chromium, BrowserContext, Page } from 'playwright';
import * as path from 'path';
import { config, getNaverCredentials } from './config';
import { checkKinSession } from './kin-search';

const PROFILE_DIR = path.resolve(__dirname, '../browser-profile');
const NAVER_LOGIN_URL = 'https://nid.naver.com/nidlogin.login';

// Fills Naver login form and submits. Credential values are never logged.
async function performNaverLogin(
  page: Page,
  creds: { id: string; password: string }
): Promise<'SUCCESS' | 'CAPTCHA' | 'FAILED'> {
  try {
    await page.goto(NAVER_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {
    return 'FAILED';
  }

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

  let submitted = false;
  for (const sel of ['.btn_login', 'button[type="submit"]', 'input[type="submit"]']) {
    try { await page.click(sel, { timeout: 3000 }); submitted = true; break; } catch { /* next */ }
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

async function setupAuth(page: Page): Promise<void> {
  await page.goto(config.kinBaseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

  const sessionValid = await checkKinSession(page);
  if (sessionValid) {
    console.log('[AUTH] SESSION_VALID — proceeding');
    return;
  }

  console.log('[AUTH] SESSION_EXPIRED — attempting credential login (max 1 attempt)');

  const creds = getNaverCredentials();
  if (!creds) {
    console.error('[AUTH] NAVER_ID/NAVER_PASSWORD not set in .env.local');
    console.error('[AUTH] First-time setup: npm run auth:naver');
    throw new Error('AUTH_NO_CREDENTIALS');
  }

  const loginResult = await performNaverLogin(page, creds);

  if (loginResult === 'CAPTCHA') {
    console.error('[AUTH] AUTH_REQUIRES_HUMAN — CAPTCHA/OTP/verification detected');
    console.error('[AUTH] Please log in manually: npm run auth:naver');
    throw new Error('AUTH_REQUIRES_HUMAN');
  }

  if (loginResult === 'FAILED') {
    console.error('[AUTH] Auto-login failed — check credentials in .env.local');
    throw new Error('AUTH_LOGIN_FAILED');
  }

  const reVerified = await checkKinSession(page);
  if (!reVerified) {
    console.error('[AUTH] Post-login KIN session verification failed');
    throw new Error('AUTH_POST_LOGIN_VERIFY_FAILED');
  }

  console.log('[AUTH] Login successful — SESSION_VALID');
}

async function run() {
  console.log('[RUN] Verifying Naver KIN auth via persistent browser profile...');

  const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    args: ['--no-sandbox'],
  });

  const page: Page = await context.newPage();

  try {
    await setupAuth(page);
    console.log('[RUN] Auth OK. Run the daily orchestration via Claude Code:');
    console.log('[RUN]   cat prompts/daily-run.md | claude -p');
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes('AUTH_REQUIRES_HUMAN')) {
      console.error('[BLOCKED] AUTH_REQUIRES_HUMAN — run npm run auth:naver first');
    } else {
      console.error('[ERROR]', e);
    }
    process.exit(1);
  } finally {
    await context.close();
  }
}

run().catch(e => {
  console.error('[FATAL]', e);
  process.exit(1);
});
