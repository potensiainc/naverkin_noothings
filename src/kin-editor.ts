import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { DRY_RUN } from './config';

export type EditorState =
  | 'EMPTY'
  | 'TEXT_INSERTED'
  | 'OG_RENDERED'
  | 'RAW_URL_REMOVED'
  | 'CARD_CENTERED'
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

  // 2. Check answer button exists.
  //    Naver renders two buttons that open the same editor: a header/inline
  //    one (.endAnswerButton._answerWriteButton, always in the DOM) and a
  //    scroll-triggered floating one (.endAnswerRegisterButton._answerWriteButton,
  //    hidden until the page is scrolled). Prefer whichever is actually visible.
  const floatingBtn = page.locator('.endAnswerRegisterButton._answerWriteButton').first();
  const inlineBtn = page.locator('.endAnswerButton._answerWriteButton').first();
  let answerBtn = floatingBtn;
  let canAnswer = await floatingBtn.isVisible().catch(() => false);
  if (!canAnswer) {
    canAnswer = await inlineBtn.isVisible().catch(() => false);
    if (canAnswer) answerBtn = inlineBtn;
  }
  if (!canAnswer) {
    return { success: false, state: 'EMPTY', error: 'No answer button' };
  }

  // 3. Click answer button — catch dialog (e.g. "답변이 허용되지 않는 디렉토리")
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
    return { success: false, state: 'EMPTY', error: `Dialog: ${dialogMsg}` };
  }

  const hasCanvasAfterClick = await page.evaluate(() => !!document.querySelector('.se-canvas'));
  if (!hasCanvasAfterClick) {
    await page.waitForTimeout(2000);
    await answerBtn.click({ timeout: 5000 }).catch(() => { /* fall through to canvas check below */ });
    await page.waitForTimeout(2500);
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

  // 6. Type answer text (keyboard.type is the only reliable method for SmartEditor)
  await page.keyboard.type(answerText, { delay: 20 });
  await page.waitForTimeout(400);

  // Verify text registered in SE component model
  const textLen = await page.evaluate((sel: string) => {
    const comps = Array.from(document.querySelectorAll(sel));
    return comps
      .filter(c => !c.classList.contains('se-oglink'))
      .map(c => (c as HTMLElement).innerText.trim())
      .join('').length;
  }, COMP_SEL);

  if (textLen < 50) {
    await saveArtifact(page, questionUrl, 'TEXT_INSERT_FAILED');
    return { success: false, state: 'EMPTY', error: `Text too short: ${textLen}` };
  }

  // 7. Press Enter then type URL to trigger OG card
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  await page.keyboard.type(articleUrl, { delay: 25 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');

  // 8. Wait for OG card (poll up to 8s). The card can flicker in and out
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
    return { success: false, state: 'TEXT_INSERTED', error: 'OG card did not render' };
  }

  // Settle check — confirm the card is still there a moment later.
  await page.waitForTimeout(1500);
  ogReady = await page.evaluate((sel: string) => !!document.querySelector(sel), OG_SEL);
  if (!ogReady) {
    await saveArtifact(page, questionUrl, 'OG_DISAPPEARED_AFTER_SETTLE');
    return { success: false, state: 'TEXT_INSERTED', error: 'OG card disappeared after settle wait' };
  }

  // 9. Delete raw URL if SmartEditor left it behind as text.
  //    SmartEditor normally converts the typed URL into the OG card and
  //    leaves an empty trailing paragraph — no raw URL text remains. In that
  //    case this step must be skipped entirely: the last text component is
  //    empty, so Backspace would run past its start and delete into the
  //    OG card component before it, destroying the card we just rendered.
  let rawUrlPresent = await page.evaluate(
    ({ sel, url }: { sel: string; url: string }) => {
      const comps = Array.from(document.querySelectorAll(sel));
      const textComps = comps.filter(c => !c.classList.contains('se-oglink'));
      return textComps.map(c => (c as HTMLElement).innerText.trim()).join('').includes(url);
    },
    { sel: COMP_SEL, url: articleUrl }
  );

  if (rawUrlPresent) {
    // Find the <p> that actually contains the raw URL text. SmartEditor
    // does NOT always leave it in a trailing empty component — it can sit
    // at the end of the very text component we typed the answer into,
    // right after the OG card is inserted as a separate component after it.
    // Targeting "the last text component" unconditionally used to grab the
    // wrong (unrelated, already-empty) component and delete into the OG
    // card by accident. Search every paragraph in every non-OG component
    // and act on the one whose own text contains the URL.
    const urlPPos = await page.evaluate(
      ({ sel, url }: { sel: string; url: string }) => {
        const comps = Array.from(document.querySelectorAll(sel));
        const textComps = comps.filter(c => !c.classList.contains('se-oglink'));
        for (const comp of textComps) {
          const paras = Array.from(comp.querySelectorAll('p'));
          for (const p of paras) {
            if (p.textContent?.includes(url)) {
              p.scrollIntoView({ behavior: 'smooth', block: 'center' });
              const r = p.getBoundingClientRect();
              return { x: r.left + 50, y: (r.top + r.bottom) / 2 };
            }
          }
        }
        return null;
      },
      { sel: COMP_SEL, url: articleUrl }
    );
    await page.waitForTimeout(500);

    if (!urlPPos) {
      await saveArtifact(page, questionUrl, 'LAST_P_NOT_FOUND');
      return { success: false, state: 'OG_RENDERED', error: 'Paragraph containing raw URL not found' };
    }

    await page.mouse.click(urlPPos.x, urlPPos.y);
    await page.waitForTimeout(200);

    // Select the whole trailing paragraph (Home, then Shift+End) and delete
    // it in one shot, instead of counting Backspaces. This paragraph only
    // ever contains the raw URL we just typed (or is already empty because
    // SmartEditor converted it into the OG card), so selecting its full
    // extent and deleting can never reach past its own boundary into the
    // OG card component before it — unlike a fixed-count Backspace loop,
    // which doesn't know how many raw characters actually remain and can
    // run past them and destroy the card.
    await page.keyboard.press('Home');
    await page.waitForTimeout(100);
    await page.keyboard.press('Shift+End');
    await page.waitForTimeout(100);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);

    const ogStillThere = await page.evaluate((sel: string) => !!document.querySelector(sel), OG_SEL);
    if (!ogStillThere) {
      await saveArtifact(page, questionUrl, 'OG_DESTROYED_DURING_URL_DELETE');
      return { success: false, state: 'OG_RENDERED', error: 'OG card destroyed while removing raw URL text' };
    }

    rawUrlPresent = await page.evaluate(
      ({ sel, url }: { sel: string; url: string }) => {
        const comps = Array.from(document.querySelectorAll(sel));
        const textComps = comps.filter(c => !c.classList.contains('se-oglink'));
        return textComps.map(c => (c as HTMLElement).innerText.trim()).join('').includes(url);
      },
      { sel: COMP_SEL, url: articleUrl }
    );

    if (rawUrlPresent) {
      await saveArtifact(page, questionUrl, 'RAW_URL_REMOVAL_FAILED');
      return { success: false, state: 'OG_RENDERED', error: 'Raw URL still present' };
    }
  }

  // 10. Scroll OG card into view (no click — clicking it risks landing on its
  //     hover-revealed delete/edit overlay and destroying the card, which is
  //     what was happening here before: the card rendered fine but vanished
  //     right after this click).
  await page.evaluate((sel: string) => {
    document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, OG_SEL);
  await page.waitForTimeout(500);

  // 11. Final gate check
  const gate = await page.evaluate(
    ({ compSel, url }: { compSel: string; url: string }) => {
      const comps = Array.from(document.querySelectorAll(compSel));
      const textComps = comps.filter(c => !c.classList.contains('se-oglink'));
      const totalText = textComps.map(c => (c as HTMLElement).innerText.trim()).join('');
      const hasOg = comps.some(c => c.classList.contains('se-oglink'));
      const rawUrl = totalText.includes(url);
      return { textLen: totalText.length, hasOg, rawUrl };
    },
    { compSel: COMP_SEL, url: articleUrl }
  );

  if (gate.textLen < 50 || !gate.hasOg || gate.rawUrl) {
    await saveArtifact(page, questionUrl, 'GATE_FAILED');
    return {
      success: false,
      state: 'CARD_CENTERED',
      error: `Gate failed: textLen=${gate.textLen} hasOg=${gate.hasOg} rawUrl=${gate.rawUrl}`,
    };
  }

  if (DRY_RUN) {
    console.log('[DRYRUN] Gate passed — skipping submit');
    return { success: true, state: 'CARD_CENTERED' };
  }

  // 12. Submit — real pointer click, same reason as the answer-open button above.
  const submitBtn = page.locator('.endAnswerButton._answerRegisterButton').first();
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
