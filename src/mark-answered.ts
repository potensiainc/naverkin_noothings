// CLI utility: marks a KIN question URL as answered.
// Called by Claude Code Runtime Agent after successful answer posting.
// Usage: npx ts-node src/mark-answered.ts "<question-url>"

import { appendAnsweredUrl } from './state';

const url = process.argv[2];
if (!url) {
  process.stderr.write('Usage: mark-answered.ts <question-url>\n');
  process.exit(1);
}

appendAnsweredUrl(url);
process.stdout.write('OK\n');
