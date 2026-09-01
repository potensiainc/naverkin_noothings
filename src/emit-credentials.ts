// Outputs Naver credentials for Claude Code Runtime Agent to use in Playwright MCP form filling.
// Values appear in Claude Code's execution context (necessary for automation).
// NEVER log to answer_log.csv, console, or any file.
// Usage: npx ts-node src/emit-credentials.ts

import { getNaverCredentials } from './config';

const creds = getNaverCredentials();
if (!creds) {
  process.stderr.write('NO_CREDENTIALS — set NAVER_ID and NAVER_PASSWORD in .env.local\n');
  process.exit(1);
}

// Output as JSON for Claude Code to parse and pass to Playwright MCP form fields
process.stdout.write(JSON.stringify({ id: creds.id, password: creds.password }) + '\n');
