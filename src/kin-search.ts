import { Page } from 'playwright';
import { config } from './config';
import { QuestionContent } from './question-matcher';

export interface SearchResult {
  questionUrl: string;
  docId: string;
  dirId: string;
  title: string;
  answerCount: number;
}

// Naver KIN search only supports these three sort values (정확도/최신순/추천순).
// A previous version invented a non-existent "answer_asc" (미답변순) sort —
// Naver silently returns a completely blank page for any unrecognized sort
// value, which made every search using it return zero results.
export type KinSearchSort = 'none' | 'date' | 'vcount';

export async function searchKin(
  page: Page,
  query: string,
  sort: KinSearchSort = 'date',
  maxResults: number = config.resultsPerQuery
): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  let pageNum = 1;

  while (results.length < maxResults) {
    const url = buildSearchUrl(query, sort, pageNum);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch {
      break;
    }

    let items: SearchResult[];
    try {
      items = await extractSearchItems(page);
    } catch {
      // "Execution context was destroyed" 등 페이지가 아직 안정화되기
      // 전에 다음 동작이 실행 컨텍스트를 깨뜨리는 경우가 있다. 지금까지
      // 모은 결과라도 반환하고 이 검색 시도는 여기서 멈춘다 — 통째로
      // throw하면 daily.ts가 이 쿼리 전체를 스킵하게 되어 결과 손실이 큼.
      break;
    }
    if (items.length === 0) break;

    for (const item of items) {
      if (results.length >= maxResults) break;
      results.push(item);
    }

    // Check if there are more pages
    const hasNext = await page.$('a[href*="page=' + (pageNum + 1) + '"]');
    if (!hasNext || results.length >= maxResults) break;
    pageNum++;
  }

  return results;
}

function buildSearchUrl(query: string, sort: KinSearchSort, page: number): string {
  const base = 'https://kin.naver.com/search/list.naver';
  const params = new URLSearchParams({
    query,
    section: 'qna',
    sort,
    page: String(page),
  });
  return `${base}?${params.toString()}`;
}

async function extractSearchItems(page: Page): Promise<SearchResult[]> {
  return page.evaluate(() => {
    const results: { questionUrl: string; docId: string; dirId: string; title: string; answerCount: number }[] = [];
    const seen = new Set<string>();

    // KIN search results: each <li> contains one question link with docId + dirId.
    // dirId is required — detail.naver rejects docId-only URLs as invalid requests.
    const allLi = Array.from(document.querySelectorAll('li'));
    for (const li of allLi) {
      // Find a link that goes to a KIN question (contains docId)
      const links = Array.from(li.querySelectorAll('a[href*="docId="]')) as HTMLAnchorElement[];
      if (links.length === 0) continue;

      // Pick the first link with meaningful text (the title link)
      const titleLink = links.find(a => a.textContent?.trim().length > 5);
      if (!titleLink) continue;

      const href = titleLink.href;
      const docIdMatch = href.match(/docId=(\d+)/);
      const dirIdMatch = href.match(/dirId=(\d+)/);
      if (!docIdMatch || !dirIdMatch) continue;
      const docId = docIdMatch[1];
      const dirId = dirIdMatch[1];
      if (seen.has(docId)) continue;
      seen.add(docId);

      const title = titleLink.textContent?.trim() ?? '';
      const cleanUrl = `https://kin.naver.com/qna/detail.naver?dirId=${dirId}&docId=${docId}`;

      // Extract answer count from sibling text
      let answerCount = 0;
      const ddText = li.textContent ?? '';
      const countMatch = ddText.match(/답변\s*(\d+)/);
      if (countMatch) answerCount = parseInt(countMatch[1], 10);

      results.push({ questionUrl: cleanUrl, docId, dirId, title, answerCount });
    }

    return results;
  });
}

export async function readQuestion(page: Page, url: string): Promise<QuestionContent | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch {
    return null;
  }

  return page.evaluate(() => {
    // Title: from page <title> tag, strip " : 지식iN"
    const rawTitle = document.title.replace(/\s*:\s*지식iN\s*$/, '').trim();

    // Body: The question text appears in a specific section.
    // Try multiple selectors to find the question body text.
    // Based on observed DOM: the question body is in a div after the title/meta area
    // Stable approach: find the question section and extract text content
    let body = '';

    // Try common class patterns for KIN question body
    const selectors = [
      '.c-heading__content',
      '.question_box .content',
      '.question_text',
      '#content .question',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent?.trim()) {
        body = el.textContent.trim();
        break;
      }
    }

    // Fallback: find all paragraphs/divs in the main content area that look like the question body
    if (!body) {
      // The question body is typically a long text block near the top of the Q&A section
      // Try to find it by structure: main content, not header, not footer, not answer
      const mainEl = document.querySelector('main, #content, .main_content, [role="main"]');
      if (mainEl) {
        // Get the first substantial text block
        const allNodes = Array.from(mainEl.querySelectorAll('p, div'));
        for (const node of allNodes) {
          const text = node.textContent?.trim() ?? '';
          // Skip very short texts, navigation, etc.
          if (text.length > 20 && !text.includes('메인 메뉴') && !text.includes('검색영역')) {
            // Avoid answers (they come after the question)
            const closestAnswer = node.closest('[id^="answer"]');
            if (!closestAnswer) {
              body = text;
              break;
            }
          }
        }
      }
    }

    if (!rawTitle || rawTitle === '페이지 없음') return null;
    return { title: rawTitle, body };
  });
}

// Navigates to KIN and checks session health via the NID_AUT auth cookie.
// The "로그인" link is present in KIN's header DOM regardless of login state,
// so it cannot be used as a login indicator — the auth cookie is authoritative.
export async function checkKinSession(page: Page): Promise<boolean> {
  await page.goto(config.kinBaseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const cookies = await page.context().cookies('https://www.naver.com');
  const hasAuthCookie = cookies.some(c => c.name === 'NID_AUT' || c.name === 'NID_SES');
  const onKin = page.url().includes('kin.naver.com');
  return hasAuthCookie && onKin;
}
