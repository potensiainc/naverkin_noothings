import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { DRY_RUN } from './config';

export type EditorState =
  | 'EMPTY'
  | 'OG_RENDERED'
  | 'ANSWER_TEXT_INSERTED'
  | 'SUBMITTED';

export interface EditorResult {
  success: boolean;
  state: EditorState;
  answerNo?: number;
  error?: string;
}

// SmartEditor selector for user-created OG link card
const OG_SEL = '.se-canvas .se-component.se-oglink:not(.__se-component)';
// SmartEditor selector for all user-created components
const COMP_SEL = '.se-canvas .se-component:not(.__se-component)';

export interface OpenEditorResult {
  opened: boolean;
  error?: string;
}

// Finds the "답변하기"/"답변" CTA and clicks it to open the SmartEditor,
// reporting whether Naver rejected the attempt outright (e.g. a
// "답변이 허용되지 않는 디렉토리입니다" dialog on FAQ-only / government-partner
// categories, where no article — however well matched — could ever be
// posted). Exported separately from postAnswer so daily.ts can call this
// as a cheap pre-check right after reading the question, before spending a
// codex call on matching/generation for a question that can never accept
// an answer.
export async function openAnswerEditor(page: Page): Promise<OpenEditorResult> {
  // Naver's class names have changed before (endAnswerButton vs
  // endAnswerRegisterButton across page layouts) and will likely change
  // again, so class-based selectors are tried first as the fast path, then
  // a text/role-based fallback searches any <button> whose visible text is
  // exactly "답변" or "답변하기" — that survives a class rename since it
  // depends on what a human would actually read on the button.
  const classCandidates = [
    page.locator('.endAnswerRegisterButton._answerWriteButton').first(),
    page.locator('.endAnswerButton._answerWriteButton').first(),
  ];
  let answerBtn = classCandidates[0];
  let canAnswer = false;
  for (const candidate of classCandidates) {
    if (await candidate.isVisible().catch(() => false)) {
      answerBtn = candidate;
      canAnswer = true;
      break;
    }
  }
  if (!canAnswer) {
    const textBtn = page.locator('button', { hasText: /^답변(하기)?$/ }).first();
    if (await textBtn.isVisible().catch(() => false)) {
      answerBtn = textBtn;
      canAnswer = true;
    }
  }
  if (!canAnswer) {
    return { opened: false, error: 'No answer button' };
  }

  // Click answer button — catch dialog (e.g. "답변이 허용되지 않는 디렉토리")
  let dialogMsg: string | null = null;
  page.once('dialog', async (d) => {
    dialogMsg = d.message();
    await d.accept();
  });

  // Real pointer click — SmartEditor only opens on a genuine mouse click;
  // a DOM-level element.click() (via page.evaluate) does not trigger it.
  // The click can silently no-op if the page's own JS hasn't finished
  // binding its handlers yet (a domcontentloaded nav can beat that), so
  // retry once after a longer settle wait before giving up.
  await answerBtn.click({ timeout: 5000 });
  await page.waitForTimeout(2500);

  if (dialogMsg) {
    return { opened: false, error: `Dialog: ${dialogMsg}` };
  }

  const hasCanvasAfterClick = await page.evaluate(() => !!document.querySelector('.se-canvas'));
  if (!hasCanvasAfterClick) {
    await page.waitForTimeout(2000);
    await answerBtn.click({ timeout: 5000 }).catch(() => { /* fall through to canvas check below */ });
    await page.waitForTimeout(2500);
  }

  return { opened: true };
}

export async function postAnswer(
  page: Page,
  questionUrl: string,
  answerText: string,
  articleUrl: string
): Promise<EditorResult> {
  // 1. Navigate to question page
  try {
    await page.goto(questionUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (e) {
    return { success: false, state: 'EMPTY', error: `Navigation failed: ${e}` };
  }

  // 2-3. Open the editor (button lookup + click + dialog detection).
  const opened = await openAnswerEditor(page);
  if (!opened.opened) {
    return { success: false, state: 'EMPTY', error: opened.error ?? 'Failed to open editor' };
  }

  // 4. Scroll SE canvas into viewport
  await page.evaluate(() => {
    document.querySelector('.se-canvas')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  await page.waitForTimeout(700);

  const canvasRect = await page.evaluate(() => {
    const c = document.querySelector('.se-canvas');
    const r = c?.getBoundingClientRect();
    return r ? { top: r.top, left: r.left, height: r.height } : null;
  });
  if (!canvasRect) {
    await saveArtifact(page, questionUrl, 'SE_CANVAS_NOT_FOUND');
    return { success: false, state: 'EMPTY', error: 'SE canvas not found' };
  }

  // 5. Click lower portion of canvas (below policy notice) to focus editor
  await page.mouse.click(canvasRect.left + 100, canvasRect.top + canvasRect.height * 0.6);
  await page.waitForTimeout(300);

  // 6. Type the article URL FIRST, on its own line, before the answer text.
  //    This is the opposite of the obvious order, but it is what makes safe
  //    raw-URL cleanup possible: typed first, the URL becomes its own
  //    isolated leading component once Naver converts it into an OG card,
  //    with nothing else sharing that component. Typed after the answer
  //    text (the original approach), the leftover raw-URL text instead
  //    lands inside (or right next to) components that also hold the real
  //    answer or the OG card, and every attempted deletion there — counted
  //    Backspaces, Home+Shift+End+Delete, repeated Home+Delete — ended up
  //    either destroying the OG card or leaving a mangled partial-URL
  //    fragment behind, because Naver auto-links the URL and a single
  //    Delete/Backspace on that auto-link removes an unpredictable chunk
  //    rather than the whole link atomically. With the URL isolated in its
  //    own component, a triple-click cleanly selects that entire paragraph
  //    and Delete removes it in one shot with no neighboring content at risk.
  await page.keyboard.type(articleUrl, { delay: 25 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');

  // 7. Wait for OG card (poll up to 8s). The card can flicker in and out
  //    while Naver fetches the link preview, so a single positive poll isn't
  //    enough — re-check after a settle delay before trusting it.
  let ogReady = false;
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1000);
    ogReady = await page.evaluate(
      (sel: string) => !!document.querySelector(sel),
      OG_SEL
    );
    if (ogReady) break;
  }
  if (!ogReady) {
    await saveArtifact(page, questionUrl, 'OG_NOT_RENDERED');
    return { success: false, state: 'EMPTY', error: 'OG card did not render' };
  }

  // Settle check — confirm the card is still there a moment later.
  await page.waitForTimeout(1500);
  ogReady = await page.evaluate((sel: string) => !!document.querySelector(sel), OG_SEL);
  if (!ogReady) {
    await saveArtifact(page, questionUrl, 'OG_DISAPPEARED_AFTER_SETTLE');
    return { success: false, state: 'EMPTY', error: 'OG card disappeared after settle wait' };
  }

  // 8. Delete the leading raw-URL paragraph via triple-click (selects the
  //    whole paragraph as one unit) + Delete, then Backspace once to merge
  //    away the now-empty line. This never touches the OG card or answer
  //    text because the URL was typed into its own isolated component.
  const hasStrayUrlText = () => page.evaluate(
    (sel: string) => {
      const comps = Array.from(document.querySelectorAll(sel));
      const textComps = comps.filter(c => !c.classList.contains('se-oglink'));
      return /https?:\/\//i.test(textComps.map(c => (c as HTMLElement).innerText).join(''));
    },
    COMP_SEL
  );

  if (await hasStrayUrlText()) {
    await page.evaluate((sel: string) => {
      const comps = Array.from(document.querySelectorAll(sel));
      const textComps = comps.filter(c => !c.classList.contains('se-oglink'));
      const first = textComps[0];
      const p = first?.querySelector('p');
      (p as HTMLElement | null)?.scrollIntoView({ behavior: 'instant', block: 'center' });
    }, COMP_SEL);
    await page.waitForTimeout(300);

    const urlPPos = await page.evaluate((sel: string) => {
      const comps = Array.from(document.querySelectorAll(sel));
      const textComps = comps.filter(c => !c.classList.contains('se-oglink'));
      const first = textComps[0];
      const p = first?.querySelector('p');
      if (!p) return null;
      const r = (p as HTMLElement).getBoundingClientRect();
      return { x: r.left + 50, y: (r.top + r.bottom) / 2 };
    }, COMP_SEL);

    if (!urlPPos) {
      await saveArtifact(page, questionUrl, 'LAST_P_NOT_FOUND');
      return { success: false, state: 'OG_RENDERED', error: 'Paragraph containing raw URL not found' };
    }

    await page.mouse.click(urlPPos.x, urlPPos.y, { clickCount: 3 });
    await page.waitForTimeout(200);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);

    const ogStillThere = await page.evaluate((sel: string) => !!document.querySelector(sel), OG_SEL);
    if (!ogStillThere) {
      await saveArtifact(page, questionUrl, 'OG_DESTROYED_DURING_URL_DELETE');
      return { success: false, state: 'OG_RENDERED', error: 'OG card destroyed while removing raw URL text' };
    }

    if (await hasStrayUrlText()) {
      await saveArtifact(page, questionUrl, 'RAW_URL_REMOVAL_FAILED');
      return { success: false, state: 'OG_RENDERED', error: 'Raw URL text still present' };
    }
  }

  // 9. Move the caret to the very start of the editor and type the answer
  //    text there, so it ends up before the OG card in reading order.
  const canvasPos = await page.evaluate(() => {
    const c = document.querySelector('.se-canvas');
    const r = c?.getBoundingClientRect();
    return r ? { x: r.left + 100, y: r.top + 20 } : null;
  });
  if (canvasPos) {
    await page.mouse.click(canvasPos.x, canvasPos.y);
    await page.waitForTimeout(200);
  }
  await page.keyboard.press('Control+Home');
  await page.waitForTimeout(100);
  await page.keyboard.type(answerText, { delay: 20 });
  await page.waitForTimeout(400);

  const textLen = await page.evaluate((sel: string) => {
    const comps = Array.from(document.querySelectorAll(sel));
    return comps
      .filter(c => !c.classList.contains('se-oglink'))
      .map(c => (c as HTMLElement).innerText.trim())
      .join('').length;
  }, COMP_SEL);

  if (textLen < 50) {
    await saveArtifact(page, questionUrl, 'TEXT_INSERT_FAILED');
    return { success: false, state: 'OG_RENDERED', error: `Text too short: ${textLen}` };
  }

  // 10. Scroll OG card into view (no click — clicking it risks landing on its
  //     hover-revealed delete/edit overlay and destroying the card).
  await page.evaluate((sel: string) => {
    document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, OG_SEL);
  await page.waitForTimeout(500);

  // 11. Final gate check. Checks for ANY leftover http(s) text, not just an
  //     exact match on the original URL string, in case any stray fragment
  //     survived step 8.
  const gate = await page.evaluate(
    (compSel: string) => {
      const comps = Array.from(document.querySelectorAll(compSel));
      const textComps = comps.filter(c => !c.classList.contains('se-oglink'));
      const totalText = textComps.map(c => (c as HTMLElement).innerText.trim()).join('');
      const hasOg = comps.some(c => c.classList.contains('se-oglink'));
      const rawUrl = /https?:\/\//i.test(totalText);
      return { textLen: totalText.length, hasOg, rawUrl };
    },
    COMP_SEL
  );

  if (gate.textLen < 50 || !gate.hasOg || gate.rawUrl) {
    await saveArtifact(page, questionUrl, 'GATE_FAILED');
    return {
      success: false,
      state: 'ANSWER_TEXT_INSERTED',
      error: `Gate failed: textLen=${gate.textLen} hasOg=${gate.hasOg} rawUrl=${gate.rawUrl}`,
    };
  }

  if (DRY_RUN) {
    console.log('[DRYRUN] Gate passed — skipping submit');
    return { success: true, state: 'ANSWER_TEXT_INSERTED' };
  }

  // 12. Submit ("등록" button next to "저장") — same class-then-text
  //     fallback strategy as the answer-open CTA above, for the same reason:
  //     class names on this page have already changed once and can again.
  let submitBtn = page.locator('.endAnswerButton._answerRegisterButton').first();
  let canSubmit = await submitBtn.isVisible().catch(() => false);
  if (!canSubmit) {
    const textSubmitBtn = page.locator('button', { hasText: /^등록$/ }).first();
    if (await textSubmitBtn.isVisible().catch(() => false)) {
      submitBtn = textSubmitBtn;
      canSubmit = true;
    }
  }
  if (!canSubmit) {
    await saveArtifact(page, questionUrl, 'SUBMIT_BUTTON_NOT_FOUND');
    return { success: false, state: 'ANSWER_TEXT_INSERTED', error: 'No submit ("등록") button found' };
  }
  await submitBtn.click({ timeout: 5000 }).catch(() => { /* handled by post-click URL check below */ });
  await page.waitForTimeout(3000);

  const resultUrl = page.url();
  const answerNoMatch = resultUrl.match(/answerNo=(\d+)/);
  if (!answerNoMatch) {
    await saveArtifact(page, questionUrl, 'SUBMIT_NO_ANSWER_NO');
    return { success: false, state: 'SUBMITTED', error: `No answerNo in URL: ${resultUrl}` };
  }

  return { success: true, state: 'SUBMITTED', answerNo: parseInt(answerNoMatch[1]) };
}

async function saveArtifact(page: Page, url: string, stage: string) {
  try {
    const dir = path.resolve(__dirname, '../artifacts/failures');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: path.join(dir, `${ts}-${stage}.png`), fullPage: false });
    fs.writeFileSync(
      path.join(dir, `${ts}-${stage}.txt`),
      `Stage: ${stage}\nURL: ${url}\nResultURL: ${page.url()}`
    );
  } catch { /* best effort */ }
}
