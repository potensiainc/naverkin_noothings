import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Article } from '../wordpress';

let subject: any = {};
try {
  subject = require('../daily-plan');
} catch {
  // RED: production module does not exist yet.
}

function article(id: number): Article {
  return { id, title: `article-${id}`, permalink: `https://noothings.kr/${id}`, publishedAt: '2026-09-11T09:00:00', plaintext: `body-${id}` };
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

console.log('\n[DAILY PLAN TESTS]');

test('uses ten random published articles when the target date has no posts', () => {
  const all = Array.from({ length: 15 }, (_, i) => article(i + 1));
  const selected = subject.buildArticlePlan([], all, 10, () => 0.5);
  assert.strictEqual(selected.length, 10);
  assert.strictEqual(new Set(selected.map((a: Article) => a.id)).size, 10);
});

test('keeps target-date articles first and supplements only until ten articles', () => {
  const fresh = [article(1), article(2), article(3)];
  const all = Array.from({ length: 15 }, (_, i) => article(i + 1));
  const selected = subject.buildArticlePlan(fresh, all, 10, () => 0.5);
  assert.deepStrictEqual(selected.slice(0, 3).map((a: Article) => a.id), [1, 2, 3]);
  assert.strictEqual(selected.length, 10);
  assert.strictEqual(new Set(selected.map((a: Article) => a.id)).size, 10);
});

test('persists the same article IDs and successful answer count for all runs on one KST date', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nothingz-daily-plan-'));
  const file = path.join(dir, 'daily-goal.json');
  try {
    const initial = subject.loadDailyGoalState('2026-09-12', file);
    assert.deepStrictEqual(initial, { date: '2026-09-12', articleIds: [], successfulAnswers: 0 });
    subject.saveDailyGoalState({ date: '2026-09-12', articleIds: [7, 4, 9], successfulAnswers: 3 }, file);
    assert.deepStrictEqual(subject.loadDailyGoalState('2026-09-12', file), {
      date: '2026-09-12', articleIds: [7, 4, 9], successfulAnswers: 3,
    });
    assert.deepStrictEqual(subject.loadDailyGoalState('2026-09-13', file), {
      date: '2026-09-13', articleIds: [], successfulAnswers: 0,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('calculates only the remaining answers needed for the daily goal', () => {
  assert.strictEqual(subject.remainingDailyAnswers(10, 0), 10);
  assert.strictEqual(subject.remainingDailyAnswers(10, 4), 6);
  assert.strictEqual(subject.remainingDailyAnswers(10, 10), 0);
  assert.strictEqual(subject.remainingDailyAnswers(10, 12), 0);
});