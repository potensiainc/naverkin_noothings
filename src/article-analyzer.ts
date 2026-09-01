// Article data types only.
// Semantic analysis is performed by Claude Code Runtime Agent (see prompts/daily-run.md).
// No analysis logic lives in this file.

import { Article } from './wordpress';

export interface ArticleContext {
  coreTopic: string;
  userSituation: string;
  problem: string;
  requiredAction: string;
  directlyAnswerableQuestions: string[];
  relatedQuestions: string[];
}

export interface ArticleAnalysis {
  context: ArticleContext;
  searchQueries: string[];
}

// Formats article data for display to the Claude Code Runtime Agent.
// Returns a structured text block Claude Code can read and reason about.
export function formatArticleForAgent(article: Article): string {
  return [
    `TITLE: ${article.title}`,
    `URL: ${article.permalink}`,
    `PUBLISHED: ${article.publishedAt}`,
    `CONTENT:\n${article.plaintext.slice(0, 4000)}`,
  ].join('\n');
}
