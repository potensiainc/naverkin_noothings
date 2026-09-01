import { Page } from 'playwright';
import { config } from './config';
import { QuestionContent } from './question-matcher';

export interface SearchResult {
  questionUrl: string;
  title: string;
  answerCount: number;
}

export async function searchKin(
  page: Page,
  query: string,
  sort: 'date' | 'answer_asc' = 'date',
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

    const items = await extractSearchItems(page);
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

function buildSearchUrl(query: string, sort: 'date' | 'answer_asc', page: number): string {
  const base = 'https://kin.naver.com/search/list.naver';
  const params = new URLSearchParams({
    query,
    section: 'qna',
    sort: sort === 'date' ? 'date' : 'answer',
    page: String(page),
  });
  return `${base}?${params.toString()}`;
}

async function extractSearchItems(page: Page): Promise<SearchResult[]> {
  return page.evaluate(() => {
    const results: { questionUrl: string; title: string; answerCount: number }[] = [];
    const seen = new Set<string>();

    // KIN search results: each <li> contains one question link with docId
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
      if (!docIdMatch) continue;
      const docId = docIdMatch[1];
      if (seen.has(docId)) continue;
      seen.add(docId);

      const title = titleLink.textContent?.trim() ?? '';
      // Build clean URL with docId only
      const cleanUrl = `https://kin.naver.com/qna/detail.naver?docId=${docId}`;

      // Extract answer count from sibling text
      let answerCount = 0;
      const ddText = li.textContent ?? '';
      const countMatch = ddText.match(/답변\s*(\d+)/);
      if (countMatch) answerCount = parseInt(countMatch[1], 10);

      results.push({ questionUrl: cleanUrl, title, answerCount });
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

    if (!rawTitle) return null;
    return { title: rawTitle, body };
  });
}

// Navigates to KIN and checks session health from KIN DOM.
// Returns true when session is valid (no login link, on KIN domain).
export async function checkKinSession(page: Page): Promise<boolean> {
  await page.goto(config.kinBaseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  return page.evaluate(() => {
    const loginLink = document.querySelector('a[href*="nidlogin.login"]');
    if (loginLink) return false;
    // Confirm we are actually on KIN (not an error page)
    const onKin = window.location.hostname.includes('kin.naver.com');
    return onKin;
  });
}
