// CLI utility: checks if Naver credentials are available in the environment.
// Outputs "CREDENTIALS_AVAILABLE" or "NO_CREDENTIALS" — never the actual values.
// Called by Claude Code Runtime Agent during auth setup.
// Usage: npx ts-node src/check-credentials.ts

import { getNaverCredentials } from './config';

const creds = getNaverCredentials();
process.stdout.write(creds ? 'CREDENTIALS_AVAILABLE\n' : 'NO_CREDENTIALS\n');
