import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AnswerParams {
  questionTitle: string;
  questionBody: string;
  articleTitle: string;
  articleUrl: string;
  articleExcerpt: string;
}

export async function generateKinAnswer(params: AnswerParams): Promise<string> {
  const prompt = buildPrompt(params);
  return runCodex(prompt);
}

export interface AnswerCritique {
  passes: boolean;
  reason: string;
}

// Self-critique gate: the formal editor gate (text length, OG card present,
// no raw URL) only checks shape, never whether the answer is actually a
// correct, on-topic, non-generic response. This asks codex to grade its own
// output against the question one more time before it goes anywhere near
// the browser, so a plausible-looking but wrong or vague answer gets caught
// here instead of being published.
export async function critiqueKinAnswer(
  params: AnswerParams,
  answerText: string
): Promise<AnswerCritique> {
  const prompt = `당신은 네이버 지식iN 답변 품질 검수자입니다. 아래 답변이 실제로 게시해도 될 만큼
질문에 명확하게 답하는지 엄격하게 판단하세요.

## 불합격 기준 (하나라도 해당하면 불합격)
- 질문에서 실제로 묻는 것에 답하지 않고 일반론만 이야기함
- 참고 포스트에 없는 내용을 지어냄 (사실관계 날조)
- 과장되거나 확인되지 않은 단정적 표현
- 광고성/홍보성 문구가 섞여 있음
- 질문자의 구체적 상황을 무시한 뻔한 답변

## 질문
제목: ${params.questionTitle}
내용: ${params.questionBody.slice(0, 800) || '(본문 없음)'}

## 참고 포스트 (답변의 유일한 근거 — 이 내용에 없는 사실은 답변에 있으면 안 됨)
제목: ${params.articleTitle}
내용: ${params.articleExcerpt.slice(0, 2000)}

## 검수할 답변
${answerText}

결과를 JSON 객체 하나로만 출력하세요 (설명, 마크다운 없이):
{"passes": true|false, "reason": "한 문장 이유"}`;

  const raw = await runCodex(prompt);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { passes: false, reason: `critique unparseable: ${raw.slice(0, 200)}` };
  try {
    const parsed = JSON.parse(match[0]);
    return {
      passes: parsed?.passes === true,
      reason: typeof parsed?.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return { passes: false, reason: `critique JSON parse failed: ${raw.slice(0, 200)}` };
  }
}

// Shared with keyword-matcher.ts — one codex CLI invocation path for the
// whole pipeline (answer writing, keyword extraction, question matching).
export function runCodexPrompt(prompt: string): Promise<string> {
  return runCodex(prompt);
}

function buildPrompt(p: AnswerParams): string {
  return `당신은 네이버 지식iN 답변 작성 도우미입니다.

## 규칙
- 답변은 4~5문단, 200~350자
- 마지막 문장은 반드시 "여기에 정리돼 있습니다." 또는 "여기서 확인할 수 있습니다."로 끝낼 것
- URL은 절대 포함하지 않을 것 (시스템이 별도로 추가함)
- 구어체, 친절한 톤
- 답변 텍스트만 출력할 것 (설명·인사·마크다운 헤더 없이)

## 질문
제목: ${p.questionTitle}
내용: ${p.questionBody.slice(0, 800) || '(본문 없음)'}

## 참고 포스트
제목: ${p.articleTitle}
내용: ${p.articleExcerpt.slice(0, 2000)}

위 질문에 맞는 답변을 작성해주세요.`;
}

// Thrown when codex reports its usage/credit limit was hit. daily.ts catches
// this specifically to stop the day's run early (rather than treating it as
// a per-article failure) — the next scheduled run picks up normally the
// following day since no state is mutated to mark anything as attempted.
export class CodexUsageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexUsageLimitError';
  }
}

// codex exec doesn't expose a temperature flag, but model_reasoning_effort
// is the equivalent quality/depth knob for its reasoning models. "high"
// trades latency for better-reasoned output, which matters more here than
// speed since this pipeline runs unattended and each call gates a real
// public answer.
const REASONING_EFFORT = 'high';

function runCodex(prompt: string): Promise<string> {
  // Write output to a temp file via codex exec -o flag
  const tmpFile = path.join(os.tmpdir(), `codex-kin-${Date.now()}.txt`);

  return new Promise((resolve, reject) => {
    // Use '-' so codex reads the prompt from stdin (avoids shell arg-splitting issues)
    // On Windows, npx resolves the codex shim; shell:true is needed for PATH resolution
    const proc = spawn(
      'codex exec --skip-git-repo-check --approve-for-me' +
        ` -c model_reasoning_effort=${REASONING_EFFORT}` +
        ` -o "${tmpFile}" -`,
      [],
      { shell: true, windowsHide: true }
    );

    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();

    let errOutput = '';
    let stdOutput = '';
    proc.stderr?.on('data', (d: Buffer) => { errOutput += d.toString(); });
    proc.stdout?.on('data', (d: Buffer) => { stdOutput += d.toString(); });

    proc.on('close', (code: number | null) => {
      try {
        if (/usage limit|rate limit exceeded|insufficient_quota/i.test(stdOutput + errOutput)) {
          reject(new CodexUsageLimitError(`codex usage limit hit: ${(stdOutput + errOutput).slice(0, 300)}`));
          return;
        }
        if (fs.existsSync(tmpFile)) {
          const answer = fs.readFileSync(tmpFile, 'utf-8').trim();
          fs.unlinkSync(tmpFile);
          if (answer) {
            resolve(answer);
          } else {
            reject(new Error(`codex returned empty answer (exit ${code})`));
          }
        } else {
          reject(new Error(`codex output file not created (exit ${code}): ${errOutput.slice(0, 200)}`));
        }
      } catch (e) {
        reject(e);
      }
    });

    proc.on('error', (e) => {
      fs.existsSync(tmpFile) && fs.unlinkSync(tmpFile);
      reject(e);
    });
  });
}
