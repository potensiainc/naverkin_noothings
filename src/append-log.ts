// CLI utility: appends an entry to answer_log.csv.
// Called by Claude Code Runtime Agent after each answer attempt.
// Usage: npx ts-node src/append-log.ts \
//   --article-title "..." --article-url "..." --question-url "..." \
//   --query "..." --match-type "DIRECT|SAME_PROBLEM|ADJACENT_ANSWERABLE|UNRELATED" \
//   --status "SUCCESS|FAILED" [--error "..."]

import { appendAnswerLog } from './state';

function arg(flag: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] ?? '' : '';
}

const articleTitle = arg('--article-title');
const articleUrl = arg('--article-url');
const questionUrl = arg('--question-url');
const queryUsed = arg('--query');
const matchType = arg('--match-type');
const status = arg('--status') as 'SUCCESS' | 'FAILED' | 'SKIPPED';
const errorMessage = arg('--error') || undefined;

if (!articleTitle || !questionUrl || !status) {
  process.stderr.write('Missing required arguments: --article-title, --question-url, --status\n');
  process.exit(1);
}

appendAnswerLog({
  registeredAt: new Date().toISOString(),
  articleTitle,
  articleUrl,
  questionUrl,
  queryUsed,
  matchType,
  status,
  errorMessage,
});

process.stdout.write('OK\n');
