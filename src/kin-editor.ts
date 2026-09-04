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

  // 2. Check answer button exists
  const canAnswer = await page.evaluate(() =>
    !!document.querySelector('.endAnswerRegisterButton._answerWriteButton')
  );
  if (!canAnswer) {
    return { success: false, state: 'EMPTY', error: 'No answer button' };
  }

  // 3. Click answer button — catch dialog (e.g. "답변이 허용되지 않는 디렉토리")
  let dialogMsg: string | null = null;
  page.once('dialog', async (d) => {
    dialogMsg = d.message();
    await d.accept();
  });

  await page.evaluate(() => {
    (document.querySelector('.endAnswerRegisterButton._answerWriteButton') as HTMLElement)?.click();
  });
  await page.waitForTimeout(2500);

  if (dialogMsg) {
    return { success: false, state: 'EMPTY', error: `Dialog: ${dialogMsg}` };
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

  // 8. Wait for OG card (poll up to 8s)
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

  // 9. Delete raw URL — it is appended to the last <p> of the last text component
  //    Strategy: click last p, press End, Backspace × url.length
  const urlLen = articleUrl.length;

  // Scroll last text comp into view
  await page.evaluate((sel: string) => {
    const comps = Array.from(document.querySelectorAll(sel));
    const textComps = comps.filter(c => !c.classList.contains('se-oglink'));
    textComps[textComps.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, COMP_SEL);
  await page.waitForTimeout(500);

  const lastPPos = await page.evaluate((sel: string) => {
    const comps = Array.from(document.querySelectorAll(sel));
    const textComps = comps.filter(c => !c.classList.contains('se-oglink'));
    const lastComp = textComps[textComps.length - 1];
    if (!lastComp) return null;
    const paras = Array.from(lastComp.querySelectorAll('p'));
    const lastP = paras[paras.length - 1];
    if (!lastP) return null;
    const r = lastP.getBoundingClientRect();
    return { x: r.left + 50, y: (r.top + r.bottom) / 2 };
  }, COMP_SEL);

  if (!lastPPos) {
    await saveArtifact(page, questionUrl, 'LAST_P_NOT_FOUND');
    return { success: false, state: 'OG_RENDERED', error: 'Last p not found' };
  }

  await page.mouse.click(lastPPos.x, lastPPos.y);
  await page.waitForTimeout(200);
  await page.keyboard.press('End');
  await page.waitForTimeout(100);

  for (let i = 0; i < urlLen; i++) {
    await page.keyboard.press('Backspace');
  }
  await page.waitForTimeout(300);

  // Verify raw URL gone from text components
  const rawUrlPresent = await page.evaluate(
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

  // 10. Click OG card center to select/center-align it
  await page.evaluate((sel: string) => {
    document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, OG_SEL);
  await page.waitForTimeout(500);

  const ogCenter = await page.evaluate((sel: string) => {
    const og = document.querySelector(sel);
    const r = og?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }, OG_SEL);

  if (ogCenter) {
    await page.mouse.click(ogCenter.x, ogCenter.y);
    await page.waitForTimeout(500);
  }

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

  // 12. Submit
  await page.evaluate(() => {
    (document.querySelector('.endAnswerButton._answerRegisterButton') as HTMLElement)?.click();
  });
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
