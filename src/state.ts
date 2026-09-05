import * as fs from 'fs';
import * as path from 'path';

const STATE_DIR = path.resolve(__dirname, '../state');
const ANSWERED_URLS_FILE = path.join(STATE_DIR, 'answered_urls.txt');
const ANSWER_LOG_FILE = path.join(STATE_DIR, 'answer_log.csv');

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function normalizeKinUrl(url: string): string {
  try {
    const u = new URL(url);
    // Keep only pathname + dirId/docId params if present
    // KIN URL example: https://kin.naver.com/qna/detail.naver?d1id=...&dirId=...&docId=...
    const docId = u.searchParams.get('docId');
    if (docId) return `kin:${docId}`;
    // Fallback: strip tracking params, keep path
    const keep = ['d1id', 'dirId', 'docId', 'qb'];
    const clean = new URL(u.origin + u.pathname);
    for (const k of keep) {
      const v = u.searchParams.get(k);
      if (v) clean.searchParams.set(k, v);
    }
    return clean.toString();
  } catch {
    return url;
  }
}

export function loadAnsweredUrls(): Set<string> {
  ensureStateDir();
  if (!fs.existsSync(ANSWERED_URLS_FILE)) return new Set();
  const lines = fs.readFileSync(ANSWERED_URLS_FILE, 'utf-8').split('\n').filter(Boolean);
  return new Set(lines);
}

// Re-reads the answered-urls file from disk rather than trusting an
// in-memory Set. daily.ts now waits tens of minutes between answers, during
// which another run (manual trigger, overlapping schedule) could append to
// this file — checking the in-memory snapshot alone could let a duplicate
// answer slip through right before submitting.
export function isUrlAnswered(questionUrl: string): boolean {
  return loadAnsweredUrls().has(normalizeKinUrl(questionUrl));
}

export function appendAnsweredUrl(questionUrl: string) {
  ensureStateDir();
  const key = normalizeKinUrl(questionUrl);
  fs.appendFileSync(ANSWERED_URLS_FILE, key + '\n', 'utf-8');
}

export interface LogEntry {
  registeredAt: string;
  articleTitle: string;
  articleUrl: string;
  questionUrl: string;
  queryUsed: string;
  matchType: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  errorMessage?: string;
}

function escapeCsv(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

export function appendAnswerLog(entry: LogEntry) {
  ensureStateDir();
  if (!fs.existsSync(ANSWER_LOG_FILE)) {
    const header = 'registered_at,article_title,article_url,question_url,query_used,match_type,status,error_message\n';
    fs.writeFileSync(ANSWER_LOG_FILE, header, 'utf-8');
  }
  const row = [
    entry.registeredAt,
    entry.articleTitle,
    entry.articleUrl,
    entry.questionUrl,
    entry.queryUsed,
    entry.matchType,
    entry.status,
    entry.errorMessage ?? '',
  ].map(escapeCsv).join(',') + '\n';
  fs.appendFileSync(ANSWER_LOG_FILE, row, 'utf-8');
}
