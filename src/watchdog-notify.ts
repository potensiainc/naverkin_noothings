import './config';
import { formatKst, notifyDiscord } from './discord-notifier';

async function main() {
  const title = process.argv[2] || '자동 복구 상태';
  const details = process.argv[3] || '(상세 내용 없음)';
  const message =
    `🛠️ **네이버 지식iN 자동 복구**\n` +
    `• 상태: ${title}\n` +
    `• 시각: ${formatKst(new Date())}\n` +
    `• 내용: ${details}`;
  await notifyDiscord(message);
}

main().catch(error => {
  console.error('[WATCHDOG-NOTIFY] 실패:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
