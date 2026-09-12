import { parse as parseHtml } from 'node-html-parser';
import { config } from './config';

export interface Article {
  id: number;
  title: string;
  permalink: string;
  publishedAt: string; // ISO 8601 KST
  plaintext: string;
}

function htmlToPlaintext(html: string): string {
  const root = parseHtml(html);
  // Remove script/style/nav elements
  root.querySelectorAll('script, style, nav, noscript').forEach(el => el.remove());
  // Remove WP_AUTO_META comments
  const text = root.textContent
    .replace(/\/\*[\s\S]*?WP_AUTO_META[\s\S]*?END_WP_AUTO_META[\s\S]*?\*\//g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function getYesterdayRangeUtc(): { after: string; before: string } {
  // Today in KST
  const nowUtc = new Date();
  // KST = UTC+9
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const nowKst = new Date(nowUtc.getTime() + kstOffsetMs);

  // Midnight KST today
  const midnightTodayKst = new Date(
    Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate())
  );
  // Midnight KST yesterday
  const midnightYesterdayKst = new Date(midnightTodayKst.getTime() - 24 * 60 * 60 * 1000);

  // Convert to UTC for WP API (subtract 9h)
  const afterUtc = new Date(midnightYesterdayKst.getTime() - kstOffsetMs);
  const beforeUtc = new Date(midnightTodayKst.getTime() - kstOffsetMs);

  return {
    after: afterUtc.toISOString(),
    before: beforeUtc.toISOString(),
  };
}

export async function fetchYesterdayArticles(): Promise<Article[]> {
  const { after, before } = getYesterdayRangeUtc();
  const url = new URL(`${config.site}/wp-json/wp/v2/posts`);
  url.searchParams.set('status', 'publish');
  url.searchParams.set('after', after);
  url.searchParams.set('before', before);
  url.searchParams.set('per_page', '50');
  url.searchParams.set('orderby', 'date');
  url.searchParams.set('order', 'desc');

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`WordPress API error: ${res.status} ${res.statusText}`);
  }

  const posts = await res.json() as Array<{
    id: number;
    date: string;
    date_gmt: string;
    link: string;
    title: { rendered: string };
    content: { rendered: string };
    status: string;
  }>;

  // Double-check: only include posts whose date_gmt is in yesterday's UTC window
  // (API should handle this, but verify to avoid edge cases)
  const afterMs = new Date(after).getTime();
  const beforeMs = new Date(before).getTime();

  return posts
    .filter(p => {
      const tMs = new Date(p.date_gmt + 'Z').getTime();
      return tMs >= afterMs && tMs < beforeMs;
    })
    .map(p => ({
      id: p.id,
      title: p.title.rendered.replace(/&amp;/g, '&').replace(/&#8211;/g, '–').replace(/&#8217;/g, '’'),
      permalink: p.link,
      publishedAt: p.date,
      plaintext: htmlToPlaintext(p.content.rendered),
    }));
}

export async function fetchAllPublishedArticles(): Promise<Article[]> {
  const articles: Article[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = new URL(`${config.site}/wp-json/wp/v2/posts`);
    url.searchParams.set('status', 'publish');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('orderby', 'date');
    url.searchParams.set('order', 'desc');

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`WordPress API error: ${res.status} ${res.statusText}`);
    totalPages = Math.max(1, Number(res.headers.get('x-wp-totalpages') ?? '1'));
    const posts = await res.json() as Array<{
      id: number;
      date: string;
      link: string;
      title: { rendered: string };
      content: { rendered: string };
    }>;
    articles.push(...posts.map(p => ({
      id: p.id,
      title: p.title.rendered.replace(/&amp;/g, '&').replace(/&#8211;/g, '–').replace(/&#8217;/g, '’'),
      permalink: p.link,
      publishedAt: p.date,
      plaintext: htmlToPlaintext(p.content.rendered),
    })));
    page++;
  } while (page <= totalPages);

  return articles;
}
export function getTargetDateLabel(): string {
  const nowUtc = new Date();
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const nowKst = new Date(nowUtc.getTime() + kstOffsetMs);
  const yesterday = new Date(nowKst.getTime() - 24 * 60 * 60 * 1000);
  const y = yesterday.getUTCFullYear();
  const m = String(yesterday.getUTCMonth() + 1).padStart(2, '0');
  const d = String(yesterday.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
