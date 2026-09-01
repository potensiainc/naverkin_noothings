// CLI utility: checks whether a KIN question URL has already been answered.
// Usage: npx ts-node src/check-answered.ts "<question-url>"
// Output: "true" or "false"

import { loadAnsweredUrls, normalizeKinUrl } from './state';

const url = process.argv[2];
if (!url) {
  process.stderr.write('Usage: check-answered.ts <question-url>\n');
  process.exit(1);
}

const answered = loadAnsweredUrls();
const key = normalizeKinUrl(url);
process.stdout.write(answered.has(key) ? 'true\n' : 'false\n');
