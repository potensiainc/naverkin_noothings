import { Article } from './wordpress';
import { QuestionContent, MatchType } from './question-matcher';
import { runCodexPrompt } from './answer-writer';

// Extracts natural-language search queries a real person would type into
// Naver 지식iN if they had the problem this article solves. Replaces the
// old mechanical title-token-splitting approach, which produced meaningless
// query fragments disconnected from the article's actual content.
export async function extractSearchQueries(article: Article, count: number): Promise<string[]> {
  const prompt = `당신은 네이버 지식iN 검색어 도출 전문가입니다.

아래 글을 읽고 이해한 뒤, 이 글이 실제로 해결할 수 있는 문제를 겪고 있는 사람이
네이버 지식iN에서 검색할 법한 자연어 검색어를 ${count}개 만들어주세요.

## 규칙
- 글 제목을 기계적으로 쪼갠 조각이 아니라, 실제 사람이 겪는 상황/문제를 표현하는 검색어여야 함
- 검색어마다 표현을 다르게: 핵심 주제, 구체적 상황, 겪는 문제, 하려는 행동 등 다양한 각도
- 각 검색어는 2~15자 내외의 짧은 구어체 표현
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

// Judges whether an article can actually answer a specific KIN question.
// Only DIRECT and SAME_PROBLEM are treated as answerable — this pipeline
// runs unattended, so a strict gate matters more than answer volume.
export async function matchArticleToQuestion(
  article: Article,
  question: QuestionContent
): Promise<{ matchType: MatchType; reason: string }> {
  const prompt = `당신은 네이버 지식iN 질문과 블로그 글의 적합성을 판단하는 전문가입니다.

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

  const raw = await runCodexPrompt(prompt);
  const parsed = parseJsonObject(raw);
  const matchType = parsed?.matchType as MatchType | undefined;
  const validTypes: MatchType[] = ['DIRECT', 'SAME_PROBLEM', 'ADJACENT_ANSWERABLE', 'UNRELATED'];
  if (!matchType || !validTypes.includes(matchType)) {
    return { matchType: 'UNRELATED', reason: `codex returned unparseable match result: ${raw.slice(0, 200)}` };
  }
  return { matchType, reason: typeof parsed?.reason === 'string' ? parsed.reason : '' };
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
