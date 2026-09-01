// Interactive helper for first-time Naver login.
// Saves session to browser-profile/ — the SINGLE persistent identity for all Naver/KIN work.
// Usage: npm run auth:naver

import { chromium } from 'playwright';
import * as path from 'path';
import { checkKinSession } from './kin-search';
import { config } from './config';

// Absolute path — must match Playwright MCP --user-data-dir in mcp-config.json
const PROFILE_DIR = path.resolve(__dirname, '../browser-profile');
const NAVER_LOGIN_URL = 'https://nid.naver.com/nidlogin.login';
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 5 * 60 * 1000;

async function authNaver() {
  console.log('[NAVER AUTH]');
  console.log('Profile:', PROFILE_DIR);
  console.log('KIN:', config.kinBaseUrl);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
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

  // Navigate to Naver login for manual user interaction
  await page.goto(NAVER_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  console.log('[NAVER AUTH] Waiting for login...');

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
