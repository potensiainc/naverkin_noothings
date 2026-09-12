export interface DiscordRunSummary {
  startedAt: string;
  finishedAt: string;
  articles: number;
  queries: number;
  searchResults: number;
  matched: number;
  qualityRejected: number;
  registrationAttempts: number;
  successes: number;
  registrationFailures: number;
  processingFailures: number;
  keywords: string[];
  stoppedReason?: string;
}

const DISCORD_MESSAGE_LIMIT = 1900;

export function buildDiscordRunSummary(summary: DiscordRunSummary): string {
  const status = summary.successes > 0 ? '✅' : '🚨';
  const keywordText = summary.keywords.length > 0
    ? summary.keywords.slice(0, 30).join(', ')
    : '(없음)';
  const lines = [
    `${status} **네이버 지식iN 자동화 실행 결과**`,
    `• 시작: ${summary.startedAt}`,
    `• 종료: ${summary.finishedAt}`,
    `• 처리 글: ${summary.articles}개`,
    `• 검색 시도: ${summary.queries}회 / 검색 결과: ${summary.searchResults}건`,
    `• 의미 매칭 통과: ${summary.matched}건`,
    `• 품질 검수 탈락: ${summary.qualityRejected}건`,
    `• 처리 실패: ${summary.processingFailures}건`,
    `• 등록 시도: ${summary.registrationAttempts}회`,
    `• 성공: ${summary.successes}건 / 등록 실패: ${summary.registrationFailures}건`,
    `• 사용 키워드: ${keywordText}`,
  ];
  if (summary.stoppedReason) lines.push(`• 종료 사유: ${summary.stoppedReason}`);
  return truncateDiscordMessage(lines.join('\n'));
}

export function buildDiscordFailure(title: string, details: string): string {
  return truncateDiscordMessage(
    `🚨 **네이버 지식iN 자동화 실패**\n• 유형: ${title}\n• 시각: ${formatKst(new Date())}\n• 내용: ${details}`
  );
}

export async function notifyDiscord(message: string): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[DISCORD] DISCORD_WEBHOOK_URL 미설정 — 알림 생략');
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: truncateDiscordMessage(message) }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.error(`[DISCORD] 전송 실패: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[DISCORD] 전송 오류:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

export function formatKst(date: Date): string {
  return date.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function truncateDiscordMessage(message: string): string {
  if (message.length <= DISCORD_MESSAGE_LIMIT) return message;
  return message.slice(0, DISCORD_MESSAGE_LIMIT - 20) + '\n…(내용 일부 생략)';
}
