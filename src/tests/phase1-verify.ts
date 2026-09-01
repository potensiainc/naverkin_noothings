import { fetchYesterdayArticles, getTargetDateLabel } from '../wordpress';

async function main() {
  console.log('[PHASE 1] Target date:', getTargetDateLabel());
  const articles = await fetchYesterdayArticles();
  console.log('[PHASE 1] Articles found:', articles.length);
  for (const a of articles) {
    console.log(`  - [${a.id}] ${a.title}`);
    console.log(`    publishedAt: ${a.publishedAt}`);
    console.log(`    permalink: ${a.permalink}`);
    console.log(`    plaintext (first 200 chars): ${a.plaintext.slice(0, 200).replace(/\n/g, ' ')}`);
  }
  if (articles.length === 0) {
    console.log('[PHASE 1] RUN_COMPLETE_NO_ARTICLES — valid result');
  }
}

main().catch((e) => {
  console.error('[PHASE 1] FAILED:', e.message);
  process.exit(1);
});
