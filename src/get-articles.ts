// CLI utility: fetches yesterday's WordPress articles and outputs JSON to stdout.
// Called by Claude Code Runtime Agent during daily-run.
// Usage: npx ts-node src/get-articles.ts

import { fetchYesterdayArticles, getTargetDateLabel } from './wordpress';

async function main() {
  const targetDate = getTargetDateLabel();
  const articles = await fetchYesterdayArticles();

  const output = {
    targetDate,
    articles: articles.map(a => ({
      id: a.id,
      title: a.title,
      permalink: a.permalink,
      publishedAt: a.publishedAt,
      plaintext: a.plaintext,
    })),
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch(e => {
  process.stderr.write(`[ERROR] ${String(e)}\n`);
  process.exit(1);
});
