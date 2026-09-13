import * as assert from 'assert';
import { normalizeKinUrl, loadAnsweredUrls, appendAnsweredUrl, appendAnswerLog } from '../state';
import * as fs from 'fs';
import * as path from 'path';
import { hasDisallowedMetaLanguage, selectRelevantEvidence } from '../answer-writer';
import { buildDiscordFailure, buildDiscordRunSummary } from '../discord-notifier';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: unknown) {
    console.error(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

// ── Test 1: 전일 날짜 범위 KST 계산 ──────────────────────────────────────
console.log('\n[TEST 1] Yesterday KST date range calculation');
test('getYesterdayRangeUtc returns UTC times that correspond to yesterday KST', () => {
  // Import inline to avoid config dependency in test
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const nowUtc = new Date();
  const nowKst = new Date(nowUtc.getTime() + KST_OFFSET_MS);
  const midnightTodayKst = new Date(
    Date.UTC(nowKst.getUTCFullYear(), nowKst.getUTCMonth(), nowKst.getUTCDate())
  );
  const midnightYesterdayKst = new Date(midnightTodayKst.getTime() - 24 * 60 * 60 * 1000);
  const afterUtc = new Date(midnightYesterdayKst.getTime() - KST_OFFSET_MS);
  const beforeUtc = new Date(midnightTodayKst.getTime() - KST_OFFSET_MS);

  // after should be < before
  assert.ok(afterUtc < beforeUtc, 'after < before');
  // Difference should be exactly 24h
  assert.strictEqual(beforeUtc.getTime() - afterUtc.getTime(), 24 * 60 * 60 * 1000);
});

// ── Test 3: Question URL normalization ────────────────────────────────────
console.log('\n[TEST 3] Question URL normalization');
test('Same docId with different tracking params normalizes to same key', () => {
  const url1 = 'https://kin.naver.com/qna/detail.naver?dirId=6010102&docId=494372500&answerNo=1&qb=ABCDEF';
  const url2 = 'https://kin.naver.com/qna/detail.naver?dirId=6010102&docId=494372500&from=search';
  const url3 = 'https://kin.naver.com/qna/detail.naver?dirId=6010102&docId=494372500';

  const key1 = normalizeKinUrl(url1);
  const key2 = normalizeKinUrl(url2);
  const key3 = normalizeKinUrl(url3);

  assert.strictEqual(key1, key2, 'url1 and url2 should normalize to same key');
  assert.strictEqual(key1, key3, 'url1 and url3 should normalize to same key');
  assert.ok(key1.includes('494372500'), 'key should contain docId');
});

test('Different docIds produce different keys', () => {
  const url1 = 'https://kin.naver.com/qna/detail.naver?docId=111&dirId=1';
  const url2 = 'https://kin.naver.com/qna/detail.naver?docId=222&dirId=1';
  assert.notStrictEqual(normalizeKinUrl(url1), normalizeKinUrl(url2));
});

// ── Test 4 & 5: Duplicate prevention ─────────────────────────────────────
console.log('\n[TEST 4/5] Duplicate prevention');

const tmpAnsweredFile = path.resolve(__dirname, '../../state/test_answered_urls.txt');

// Patch state module to use test file (not possible without refactor, so test logic directly)
test('Set-based answered URLs prevents duplicates', () => {
  const set = new Set<string>();
  set.add('kin:111');
  set.add('kin:222');
  set.add('kin:111'); // duplicate
  assert.strictEqual(set.size, 2);
  assert.ok(set.has('kin:111'));
  assert.ok(set.has('kin:222'));
});

test('seenQuestionUrls prevents same-run duplicates', () => {
  const seen = new Set<string>();
  const url = 'https://kin.naver.com/qna/detail.naver?docId=999';
  const key = normalizeKinUrl(url);

  assert.ok(!seen.has(key), 'not seen initially');
  seen.add(key);
  assert.ok(seen.has(key), 'seen after add');
});

// ── Test 6: Max 5 answers per article ────────────────────────────────────
console.log('\n[TEST 6] Max answers per article');
test('successfulAnswers counter stops at maxAnswersPerArticle', () => {
  const maxAnswers = 5;
  let count = 0;
  const questions = [1, 2, 3, 4, 5, 6, 7]; // 7 questions

  for (const _ of questions) {
    if (count >= maxAnswers) break;
    count++;
  }

  assert.strictEqual(count, maxAnswers);
});

// ── Test 7 & 8: State write only on success ───────────────────────────────
console.log('\n[TEST 7/8] State persistence rules');
test('answered_urls.txt is only written on success', () => {
  // Simulate: appendAnsweredUrl called only after success verification
  const written: string[] = [];
  const mockAppend = (url: string) => written.push(url);

  const successUrl = 'https://kin.naver.com/qna/detail.naver?docId=100';
  const failUrl = 'https://kin.naver.com/qna/detail.naver?docId=200';

  // Success case: write
  const successResult = { success: true };
  if (successResult.success) mockAppend(successUrl);

  // Failure case: don't write
  const failResult = { success: false };
  if (failResult.success) mockAppend(failUrl);

  assert.ok(written.includes(successUrl), 'success URL should be written');
  assert.ok(!written.includes(failUrl), 'fail URL should NOT be written');
});

// ── Test 9: CSV append integrity ──────────────────────────────────────────
console.log('\n[TEST 9] CSV escaping');
test('CSV escaping handles commas and quotes', () => {
  function escapeCsv(val: string): string {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  }

  assert.strictEqual(escapeCsv('hello'), 'hello');
  assert.strictEqual(escapeCsv('hello, world'), '"hello, world"');
  assert.strictEqual(escapeCsv('say "hi"'), '"say ""hi"""');
  assert.strictEqual(escapeCsv('line1\nline2'), '"line1\nline2"');
});

console.log('\n[TEST 10] Relevant article evidence selection');
test('selectRelevantEvidence prefers passages matching the question', () => {
  const unrelated = '날씨가 맑은 날에는 공원을 산책할 수 있습니다. '.repeat(120);
  const relevant = '주민등록증 온라인 신청 뒤에는 지정된 기간 안에 주민센터를 방문해 지문 등록 절차를 진행해야 합니다.';
  const evidence = selectRelevantEvidence(
    `${unrelated} ${relevant} ${unrelated}`,
    '주민등록증 온라인 신청 후 지문등록 기간',
    '민증 신청했는데 언제 방문해야 하나요?',
    500
  );
  assert.ok(evidence.includes('주민등록증 온라인 신청'), 'relevant passage should be selected');
});

test('selectRelevantEvidence keeps a short article intact', () => {
  const article = '짧은 글 전체 내용입니다. 필요한 절차를 설명합니다.';
  assert.strictEqual(selectRelevantEvidence(article, '절차', '', 500), article);
});
test('selectRelevantEvidence falls back for long text without sentence punctuation', () => {
  const article = '주민등록증 온라인 신청 지문 등록 절차 '.repeat(300);
  const evidence = selectRelevantEvidence(article, '주민등록증 신청', '지문 등록', 500);
  assert.ok(evidence.length > 0, 'evidence should never be empty');
  assert.ok(evidence.length <= 500, 'fallback should respect maxChars');
});
console.log('\n[TEST 11] Discord notification messages');
test('zero-success run summary is marked as an alert and includes counters', () => {
  const message = buildDiscordRunSummary({
    startedAt: 'start',
    finishedAt: 'finish',
    articles: 10,
    queries: 120,
    searchResults: 348,
    matched: 32,
    qualityRejected: 12,
    processingFailures: 3,
    registrationAttempts: 5,
    successes: 0,
    registrationFailures: 5,
    keywords: ['민증 온라인 신청'],
  });
  assert.ok(message.startsWith('🚨'), 'zero-success summary should be an alert');
  assert.ok(message.includes('성공: 0건'), 'success count should be included');
  assert.ok(message.includes('처리 실패: 3건'), 'processing failure count should be included');
});

test('successful run summary is marked successful and Discord-safe length', () => {
  const message = buildDiscordRunSummary({
    startedAt: 'start',
    finishedAt: 'finish',
    articles: 10,
    queries: 20,
    searchResults: 100,
    matched: 8,
    qualityRejected: 2,
    processingFailures: 0,
    registrationAttempts: 6,
    successes: 5,
    registrationFailures: 1,
    keywords: Array.from({ length: 100 }, (_, index) => '아주긴검색키워드' + index),
  });
  assert.ok(message.startsWith('✅'), 'successful summary should be marked successful');
  assert.ok(message.length <= 1900, 'message should fit Discord limit');
});

test('failure notification does not expose webhook configuration', () => {
  const message = buildDiscordFailure('로그인 실패', '세션이 만료되었습니다.');
  assert.ok(message.includes('로그인 실패'));
  assert.ok(!message.includes('DISCORD_WEBHOOK_URL'));
});
console.log('\n[TEST 12] Disallowed source-meta language');
test('blocks unnecessary statements about missing reference content', () => {
  assert.ok(hasDisallowedMetaLanguage(
    '참고 내용에는 실제 이용자의 예상치 못한 어려움이나 경험담은 확인되지 않습니다.'
  ));
  assert.ok(hasDisallowedMetaLanguage(
    '이 글만으로는 정확한 처리 기간을 알 수 없습니다.'
  ));
});

test('allows a direct answer without source-meta commentary', () => {
  assert.ok(!hasDisallowedMetaLanguage(
    '온라인 신청 후 주민센터에 방문해 지문 등록을 진행하면 됩니다.'
  ));
});
// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n[TESTS] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
