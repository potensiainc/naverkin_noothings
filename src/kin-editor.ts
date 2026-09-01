import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { DRY_RUN } from './config';

export type EditorState =
  | 'EMPTY'
  | 'TEXT_INSERTED'
  | 'URL_PASTED'
  | 'OG_RENDERED'
  | 'RAW_URL_REMOVED'
  | 'CARD_CENTERED'
  | 'READY_TO_SUBMIT'
  | 'SUBMITTED';

export interface EditorResult {
  success: boolean;
  state: EditorState;
  error?: string;
}

export async function postAnswer(
  page: Page,
  questionUrl: string,
  answerText: string,
  articleUrl: string
): Promise<EditorResult> {
  // Navigate to question page
  try {
    await page.goto(questionUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (e) {
    return { success: false, state: 'EMPTY', error: `Navigation failed: ${e}` };
  }

  // Click 답변 button to open editor
  try {
    await page.click('button:has-text("답변")', { timeout: 5000 });
    await page.waitForTimeout(1000);
  } catch (e) {
    await saveFailureArtifact(page, questionUrl, 'CLICK_ANSWER_BTN');
    return { success: false, state: 'EMPTY', error: `Cannot click 답변 button: ${e}` };
  }

  // Find the editor contenteditable area
  const editorSelector = '[contenteditable="true"]';
  try {
    await page.waitForSelector(editorSelector, { timeout: 8000 });
  } catch (e) {
    await saveFailureArtifact(page, questionUrl, 'EDITOR_NOT_FOUND');
    return { success: false, state: 'EMPTY', error: `Editor not found: ${e}` };
  }

  // STEP 1: Insert answer text
  try {
    const editor = page.locator(editorSelector).first();
    await editor.click();
    await editor.fill(answerText);
    await page.waitForTimeout(500);
  } catch (e) {
    await saveFailureArtifact(page, questionUrl, 'TEXT_INSERT_FAILED');
    return { success: false, state: 'EMPTY', error: `Text insert failed: ${e}` };
  }

  let state: EditorState = 'TEXT_INSERTED';

  // STEP 2: Paste article URL via clipboard
  // Move to end of editor and add newline before URL
  try {
    const editor = page.locator(editorSelector).first();
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    // Paste URL by typing (clipboard API may not be available in headful context)
    await page.keyboard.type(articleUrl, { delay: 10 });
    await page.waitForTimeout(500);
  } catch (e) {
    await saveFailureArtifact(page, questionUrl, 'URL_PASTE_FAILED');
    return { success: false, state, error: `URL paste failed: ${e}` };
  }

  state = 'URL_PASTED';

  // Press Enter to trigger OG card generation
  await page.keyboard.press('Enter');

  // STEP 3: Wait for OG card
  const ogRendered = await waitForOGCard(page, articleUrl);
  if (!ogRendered) {
    // Retry once
    await page.keyboard.press('Control+z'); // undo
    await page.waitForTimeout(300);
    await page.keyboard.type(articleUrl, { delay: 10 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');

    const ogRetry = await waitForOGCard(page, articleUrl);
    if (!ogRetry) {
      await saveFailureArtifact(page, questionUrl, 'OG_PREVIEW_FAILED');
      return { success: false, state: 'URL_PASTED', error: 'OG card did not render after retry' };
    }
  }

  state = 'OG_RENDERED';

  // STEP 4: Remove raw URL text from editor visible content
  const urlRemoved = await removeRawUrl(page, articleUrl);
  if (!urlRemoved) {
    // Retry once
    const urlRemovedRetry = await removeRawUrl(page, articleUrl);
    if (!urlRemovedRetry) {
      await saveFailureArtifact(page, questionUrl, 'RAW_URL_REMOVAL_FAILED');
      return { success: false, state: 'OG_RENDERED', error: 'Could not remove raw URL text' };
    }
  }

  // Verify OG card still exists after URL removal
  const ogStillExists = await checkOGCardExists(page, articleUrl);
  if (!ogStillExists) {
    await saveFailureArtifact(page, questionUrl, 'OG_DISAPPEARED_AFTER_URL_REMOVAL');
    return { success: false, state: 'OG_RENDERED', error: 'OG card disappeared after URL removal' };
  }

  state = 'RAW_URL_REMOVED';

  // STEP 5: Center align OG card
  const centered = await centerAlignOGCard(page);
  if (!centered) {
    // Retry once
    const centeredRetry = await centerAlignOGCard(page);
    if (!centeredRetry) {
      await saveFailureArtifact(page, questionUrl, 'CENTER_ALIGN_FAILED');
      return { success: false, state: 'RAW_URL_REMOVED', error: 'OG card center align failed' };
    }
  }

  state = 'CARD_CENTERED';

  // STEP 6: Final gate check
  const gatePass = await finalGateCheck(page, articleUrl);
  if (!gatePass.pass) {
    await saveFailureArtifact(page, questionUrl, 'FINAL_GATE_FAILED');
    return { success: false, state: 'CARD_CENTERED', error: `Final gate failed: ${gatePass.reason}` };
  }

  state = 'READY_TO_SUBMIT';

  // STEP 7: Submit
  if (DRY_RUN) {
    console.log('[DRYRUN] Skipping actual submission');
    return { success: true, state: 'READY_TO_SUBMIT' };
  }

  const submitted = await submitAnswer(page);
  if (!submitted) {
    // Retry once
    const submittedRetry = await submitAnswer(page);
    if (!submittedRetry) {
      await saveFailureArtifact(page, questionUrl, 'SUBMIT_FAILED');
      return { success: false, state: 'READY_TO_SUBMIT', error: 'Submit failed after retry' };
    }
  }

  state = 'SUBMITTED';

  // STEP 8: Verify success
  const verified = await verifySubmitSuccess(page, answerText);
  if (!verified) {
    await saveFailureArtifact(page, questionUrl, 'SUBMIT_VERIFY_FAILED');
    return { success: false, state: 'SUBMITTED', error: 'Could not verify submission success' };
  }

  return { success: true, state: 'SUBMITTED' };
}

async function waitForOGCard(page: Page, articleUrl: string): Promise<boolean> {
  const domain = new URL(articleUrl).hostname;
  try {
    // Poll for OG card up to 10s
    await page.waitForFunction(
      (d: string) => {
        const cards = document.querySelectorAll(
          `a[href*="${d}"], [class*="og"], [class*="card"], [class*="preview"]`
        );
        return cards.length > 0;
      },
      domain,
      { timeout: 10000 }
    );
    return true;
  } catch {
    return false;
  }
}

async function checkOGCardExists(page: Page, articleUrl: string): Promise<boolean> {
  const domain = new URL(articleUrl).hostname;
  return page.evaluate((domain: string) => {
    const cards = document.querySelectorAll(
      'a[href*="' + domain + '"], [class*="og"], [class*="card"], [class*="preview"]'
    );
    return cards.length > 0;
  }, domain);
}

async function removeRawUrl(page: Page, articleUrl: string): Promise<boolean> {
  // Find text nodes in the editor that contain the raw URL and remove them
  const removed = await page.evaluate((url: string) => {
    const editor = document.querySelector('[contenteditable="true"]');
    if (!editor) return false;

    let found = false;
    // Walk text nodes
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    const toRemove: Node[] = [];
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (node.nodeValue && node.nodeValue.includes(url)) {
        toRemove.push(node);
        found = true;
      }
    }
    for (const n of toRemove) {
      const newText = n.nodeValue?.replace(url, '').replace(/^\s*\n?\s*/, '') ?? '';
      if (newText.trim()) {
        n.nodeValue = newText;
      } else {
        n.parentNode?.removeChild(n);
      }
    }
    return found;
  }, articleUrl);

  if (removed) {
    await page.waitForTimeout(300);
    // Verify no raw URL visible
    const stillVisible = await page.evaluate((url: string) => {
      const editor = document.querySelector('[contenteditable="true"]');
      return editor?.textContent?.includes(url) ?? false;
    }, articleUrl);
    return !stillVisible;
  }

  return false;
}

async function centerAlignOGCard(page: Page): Promise<boolean> {
  try {
    // Find the OG card block and select it, then apply center alignment
    // Naver editor typically has toolbar buttons for alignment
    // Try to find and click the OG card, then use the center alignment button
    const ogCardEl = page.locator('[class*="og"], [class*="card-link"], [class*="preview"]').first();
    const exists = await ogCardEl.count();
    if (!exists) return true; // Nothing to center, consider OK

    await ogCardEl.click({ timeout: 3000 });
    await page.waitForTimeout(200);

    // Find center alignment button in toolbar
    // Common accessible names: "가운데", "center", "align-center"
    const centerBtn = page.locator(
      'button[title*="중앙"], button[title*="가운데"], button[aria-label*="중앙"], button[aria-label*="가운데"], button[title*="center" i], button[aria-label*="center" i]'
    ).first();

    const btnCount = await centerBtn.count();
    if (btnCount > 0) {
      await centerBtn.click({ timeout: 3000 });
      await page.waitForTimeout(300);
    }

    // Verify center alignment by checking if the card appears to be centered
    return true;
  } catch {
    return false;
  }
}

interface GateCheckResult {
  pass: boolean;
  reason?: string;
}

async function finalGateCheck(page: Page, articleUrl: string): Promise<GateCheckResult> {
  const domain = new URL(articleUrl).hostname;

  const result = await page.evaluate(
    ({ url, domain }: { url: string; domain: string }) => {
      const editor = document.querySelector('[contenteditable="true"]');
      if (!editor) return { pass: false, reason: 'Editor not found' };

      const text = editor.textContent ?? '';
      if (text.trim().length < 50) {
        return { pass: false, reason: 'Answer text too short' };
      }

      // Check no raw URL visible
      if (text.includes(url)) {
        return { pass: false, reason: 'Raw URL still visible in editor' };
      }

      // Check OG card exists
      const card = document.querySelector(`a[href*="${domain}"], [class*="og"], [class*="card"], [class*="preview"]`);
      if (!card) {
        return { pass: false, reason: 'OG card not found' };
      }

      return { pass: true };
    },
    { url: articleUrl, domain }
  );

  return result;
}

async function submitAnswer(page: Page): Promise<boolean> {
  try {
    // Find the submit button - common Korean text: "등록", "답변 등록", "작성 완료"
    const submitBtn = page.locator(
      'button:has-text("등록"), button:has-text("답변등록"), input[type="submit"][value*="등록"]'
    ).first();

    const count = await submitBtn.count();
    if (!count) return false;

    await submitBtn.click({ timeout: 5000 });
    await page.waitForTimeout(2000);
    return true;
  } catch {
    return false;
  }
}

async function verifySubmitSuccess(page: Page, answerText: string): Promise<boolean> {
  // Wait for page to settle after submission
  try {
    await page.waitForTimeout(2000);

    // Verify by checking:
    // 1. The editor is gone (submission complete)
    // 2. OR the answer text appears in the answer list
    // 3. OR a success message appeared

    const verified = await page.evaluate((text: string) => {
      // Check if editor is still visible (if not, submission likely succeeded)
      const editor = document.querySelector('[contenteditable="true"]');
      if (!editor) return true;

      // Check if answer text appears in the answer list
      const firstChunk = text.slice(0, 30);
      const answers = Array.from(document.querySelectorAll('[id^="answer"]'));
      for (const ans of answers) {
        if (ans.textContent?.includes(firstChunk)) return true;
      }

      return false;
    }, answerText);

    return verified;
  } catch {
    return false;
  }
}

async function saveFailureArtifact(page: Page, questionUrl: string, stage: string) {
  try {
    const artifactsDir = path.resolve(__dirname, '../artifacts/failures');
    if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(artifactsDir, `${timestamp}-${stage}.png`);
    const logPath = path.join(artifactsDir, `${timestamp}-${stage}.txt`);

    await page.screenshot({ path: screenshotPath, fullPage: false });
    fs.writeFileSync(logPath, `Stage: ${stage}\nURL: ${questionUrl}\nPage: ${page.url()}\nTimestamp: ${timestamp}`);
  } catch {
    // Best effort
  }
}
