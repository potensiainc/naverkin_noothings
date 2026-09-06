// Question/Match types only.
// Semantic matching is performed by Claude Code Runtime Agent (see prompts/daily-run.md).
// No scoring or keyword logic lives in this file.

export type MatchType = 'DIRECT' | 'SAME_PROBLEM' | 'ADJACENT_ANSWERABLE' | 'UNRELATED';

export interface QuestionContent {
  title: string;
  body: string;
  // False when the question's category (e.g. a government-FAQ-only dirId)
  // rejects regular-member answers outright — Naver shows a "답변이 허용되지
  // 않는 디렉토리입니다" dialog on submit in that case regardless of match
  // quality. Checked cheaply at read time so daily.ts can skip straight to
  // the next candidate instead of spending a codex call on something that
  // can never be posted.
  answerable: boolean;
}

export interface MatchResult {
  matchType: MatchType;
  reason: string;
}

// Formats question + article context for display to the Claude Code Runtime Agent.
export function formatQuestionForAgent(question: QuestionContent): string {
  return [
    `QUESTION TITLE: ${question.title}`,
    `QUESTION BODY:\n${question.body.slice(0, 2000)}`,
  ].join('\n');
}
