import * as fs from 'fs';
import * as path from 'path';
import { Article } from './wordpress';

export interface DailyGoalState {
  date: string;
  articleIds: number[];
  successfulAnswers: number;
}

const DEFAULT_STATE_FILE = path.resolve(__dirname, '../state/daily-goal.json');

export function buildArticlePlan(
  targetArticles: Article[],
  allArticles: Article[],
  minimumSize: number,
  random: () => number = Math.random
): Article[] {
  const selected = [...targetArticles];
  const selectedIds = new Set(selected.map(article => article.id));
  const candidates = allArticles.filter(article => !selectedIds.has(article.id));

  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  for (const article of candidates) {
    if (selected.length >= minimumSize) break;
    selected.push(article);
  }

  return selected;
}

export function loadDailyGoalState(date: string, file = DEFAULT_STATE_FILE): DailyGoalState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<DailyGoalState>;
    if (parsed.date === date && Array.isArray(parsed.articleIds) && typeof parsed.successfulAnswers === 'number') {
      return {
        date,
        articleIds: parsed.articleIds.filter((id): id is number => Number.isInteger(id)),
        successfulAnswers: Math.max(0, Math.floor(parsed.successfulAnswers)),
      };
    }
  } catch {
    // Missing or invalid state starts a fresh KST day.
  }
  return { date, articleIds: [], successfulAnswers: 0 };
}

export function saveDailyGoalState(state: DailyGoalState, file = DEFAULT_STATE_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  fs.renameSync(tempFile, file);
}

export function remainingDailyAnswers(goal: number, successfulAnswers: number): number {
  return Math.max(0, goal - successfulAnswers);
}

export function getKstDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}