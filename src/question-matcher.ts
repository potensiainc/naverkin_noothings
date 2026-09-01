// Question/Match types only.
// Semantic matching is performed by Claude Code Runtime Agent (see prompts/daily-run.md).
// No scoring or keyword logic lives in this file.

export type MatchType = 'DIRECT' | 'SAME_PROBLEM' | 'ADJACENT_ANSWERABLE' | 'UNRELATED';

export interface QuestionContent {
  title: string;
  body: string;
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
