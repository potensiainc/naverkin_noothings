import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load credentials from project root .env.local
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
// Fallback to .env
dotenv.config({ path: path.resolve(__dirname, '../.env') });

interface Config {
  site: string;
  timezone: string;
  queriesPerArticle: number;
  resultsPerQuery: number;
  maxAnswersPerArticle: number;
  dailyAnswerGoal: number;
  minimumDailyArticlePool: number;
  submitRetry: number;
  navigationRetry: number;
  autoSubmit: boolean;
  kinBaseUrl: string;
}

const raw = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../config.json'), 'utf-8')
) as Config;

export const config: Config = raw;
export const DRY_RUN = process.env.DRY_RUN === 'true';

// Credentials: read from env, never logged or hard-coded
export function getNaverCredentials(): { id: string; password: string } | null {
  const id = process.env.NAVER_ID;
  const password = process.env.NAVER_PASSWORD;
  if (!id || !password) return null;
  return { id, password };
}
