import { Article } from './wordpress';
import { QuestionContent, MatchType } from './question-matcher';
import { runCodexPrompt } from './answer-writer';

// Extracts natural-language search queries a real person would type into
// Naver 지식iN if they had the problem this article solves. Replaces the
// old mechanical title-token-splitting approach, which produced meaningless
// query fragments disconnected from the article's actual content.
export async function extractSearchQueries(article: Article, count: number): Promise<string[]> {
  const prompt = `당신은 네이버 지식iN 검색어 도출 전문가입니다.

아래 글을 읽고 이해한 뒤 네이버 지식iN에서 관련 질문을 찾기 위한 짧은 검색 키워드를
${count}개 만들어주세요.

## 규칙
- 검색어는 질문 문장이 아니라 핵심 대상 + 행동 또는 조건을 결합한 2~4어절 명사형 키워드
- 핵심 대상을 생략하지 말고 사람들이 실제로 쓰는 동의 표현을 함께 생성 (예: 민증/주민등록증)
- 앞 8개는 짧은 핵심 조합, 뒤 4개는 구체적인 문제 상황 조합으로 구성
- 어떻게 하나요, 알려주세요, 궁금해요 같은 문장형 종결 표현과 물음표 사용 금지
- 좋은 예: 민증 온라인 신청, 주민등록증 온라인 신청, 주민등록증 지문등록 기간, 민증 지문등록 기간
- 대상·행동·조건 중 적어도 두 요소를 포함하고, 의미가 완전히 같은 검색어는 중복 생성하지 않음
- 결과는 JSON 배열만 출력 (설명, 마크다운, 코드블록 없이): ["검색어1", "검색어2", ...]

## 글
제목: ${article.title}
내용: ${article.plaintext.slice(0, 3000)}

위 글에 대한 검색어 ${count}개를 JSON 배열로 출력하세요.`;

  const raw = await runCodexPrompt(prompt);
  const queries = parseJsonArray(raw);
  if (queries.length === 0) {
    throw new Error(`extractSearchQueries: codex returned no parseable queries: ${raw.slice(0, 200)}`);
  }
  return queries.slice(0, count);
}

const MATCH_PROMPT = (article: Article, question: QuestionContent) => `당신은 네이버 지식iN 질문과 블로그 글의 적합성을 판단하는 전문가입니다.

질문자가 실제로 처한 상황과 겪는 문제를 이해하고, 아래 글이 그 문제를 해결해줄 수 있는지 판단하세요.

## 판단 기준
- DIRECT: 글이 질문에 거의 직접적으로 답한다
- SAME_PROBLEM: 표현이나 구체 상황은 달라도 해결하려는 문제가 본질적으로 동일하다
- ADJACENT_ANSWERABLE: 정확히 같은 질문은 아니지만 글로 질문자의 문제를 상당 부분 해결할 수 있다
- UNRELATED: 일부 단어나 주제만 같을 뿐 실제 문제가 다르다

키워드가 겹쳐도 실제 해결하려는 문제(Job)가 다르면 UNRELATED로 판단하세요.

## 질문
제목: ${question.title}
내용: ${question.body.slice(0, 1500) || '(본문 없음)'}

## 글
제목: ${article.title}
내용: ${article.plaintext.slice(0, 2000)}

결과를 JSON 객체 하나로만 출력하세요 (설명, 마크다운 없이):
{"matchType": "DIRECT|SAME_PROBLEM|ADJACENT_ANSWERABLE|UNRELATED", "reason": "한 문장 이유"}`;

const MATCH_RANK: Record<MatchType, number> = {
  DIRECT: 3,
  SAME_PROBLEM: 2,
  ADJACENT_ANSWERABLE: 1,
  UNRELATED: 0,
};

async function callMatchOnce(article: Article, question: QuestionContent): Promise<{ matchType: MatchType; reason: string }> {
  const raw = await runCodexPrompt(MATCH_PROMPT(article, question));
  const parsed = parseJsonObject(raw);
  const matchType = parsed?.matchType as MatchType | undefined;
  const validTypes: MatchType[] = ['DIRECT', 'SAME_PROBLEM', 'ADJACENT_ANSWERABLE', 'UNRELATED'];
  if (!matchType || !validTypes.includes(matchType)) {
    return { matchType: 'UNRELATED', reason: `codex returned unparseable match result: ${raw.slice(0, 200)}` };
  }
  return { matchType, reason: typeof parsed?.reason === 'string' ? parsed.reason : '' };
}

// Judges whether an article can actually answer a specific KIN question.
// LLM judgments aren't deterministic, and this pipeline publishes to a real
// public site unattended — a single roll of the dice deciding "this article
// answers this question" is too fragile. Call the judge twice and only
// trust the result when both calls agree; on disagreement, take whichever
// of the two is more conservative (closer to UNRELATED) rather than
// guessing, since a false negative (skipped question) costs nothing but a
// false positive (wrong-article answer) costs a real, public mistake.
//
// The two calls run sequentially, not via Promise.all. Two `codex exec`
// processes launched at the same instant intermittently crash each other
// with a Rust panic in codex's own starlark dependency (an
// Option::unwrap() on None, observed during E2E verification on
// 2026-09-07) — this is a codex CLI concurrency bug, not something our
// code can catch cleanly, since it kills the child process before it ever
// writes the output file. Running one full call after the other avoids
// triggering it, at the cost of roughly doubling this function's latency.
export async function matchArticleToQuestion(
  article: Article,
  question: QuestionContent
): Promise<{ matchType: MatchType; reason: string; agreed: boolean }> {
  const first = await callMatchOnce(article, question);
  const second = await callMatchOnce(article, question);

  if (first.matchType === second.matchType) {
    return { ...first, agreed: true };
  }

  const conservative = MATCH_RANK[first.matchType] <= MATCH_RANK[second.matchType] ? first : second;
  return {
    matchType: conservative.matchType,
    reason: `판단 불일치(${first.matchType} vs ${second.matchType}) — 보수적 결과 채택: ${conservative.reason}`,
    agreed: false,
  };
}

function parseJsonArray(raw: string): string[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  } catch {
    // fall through
  }
  return [];
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return null;
}
