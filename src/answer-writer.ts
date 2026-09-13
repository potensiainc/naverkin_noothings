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

export interface AnswerCritique {
  verdict: 'PASS' | 'REWRITE' | 'REJECT';
  reason: string;
}

export interface VerifiedAnswer {
  answerText: string;
  critique: AnswerCritique;
  rewriteCount: number;
}

const MAX_REWRITES = 2;
const REASONING_EFFORT = 'high';

const DISALLOWED_META_PATTERNS = [
  /참고\s*(?:내용|포스트|글|자료)(?:에는|에서는|에)?[\s\S]{0,100}(?:확인되지|나와 있지|명시되어 있지|포함되어 있지|없습니다|다루지)/i,
  /제공된\s*(?:내용|정보|자료)(?:에는|에서는|에)?[\s\S]{0,100}(?:확인되지|나와 있지|명시되어 있지|없습니다|다루지)/i,
  /(?:글|자료|포스트)(?:만으로는|에서는)[\s\S]{0,80}(?:알 수 없|확인할 수 없|판단하기 어렵)/i,
];

export function hasDisallowedMetaLanguage(answerText: string): boolean {
  return DISALLOWED_META_PATTERNS.some(pattern => pattern.test(answerText));
}

export function selectRelevantEvidence(
  articleText: string,
  questionTitle: string,
  questionBody: string,
  maxChars = 5000
): string {
  const normalized = articleText.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;

  const queryTokens = new Set(
    `${questionTitle} ${questionBody}`.toLowerCase().match(/[가-힣a-z0-9]{2,}/g) ?? []
  );
  const chunks = normalized
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((text, index) => ({ text: text.trim(), index }))
    .filter(item => item.text.length >= 20);
  const ranked = chunks.map(item => {
    const tokens = item.text.toLowerCase().match(/[가-힣a-z0-9]{2,}/g) ?? [];
    const overlap = new Set(tokens.filter(token => queryTokens.has(token))).size;
    return { ...item, score: overlap * 10 + Math.min(item.text.length, 300) / 300 };
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);

  const selected: typeof chunks = [];
  let length = 0;
  for (const item of ranked) {
    if (length + item.text.length + 1 > maxChars) continue;
    selected.push(item);
    length += item.text.length + 1;
    if (length >= maxChars * 0.8) break;
  }
  const evidence = selected.sort((a, b) => a.index - b.index).map(item => item.text).join('\n');
  return evidence || normalized.slice(0, maxChars);
}

export async function generateKinAnswer(params: AnswerParams): Promise<string> {
  return runCodex(`당신은 네이버 지식iN 답변 작성 도우미입니다.

## 규칙
- 질문에 대한 직접적인 결론을 첫 문장에 쓸 것
- 참고 포스트에서 확인되는 사실만 사용하고 없는 내용을 추측하거나 채우지 말 것
- 자연스러운 2~4문단, 보통 100~300자. 질문에 충분히 답했다면 분량을 억지로 늘리지 말 것
- 포스트가 질문 일부만 해결할 수 있으면 근거가 있는 해결 방법만 자연스럽게 답하고 나머지는 생략할 것
- 참고 내용에 무엇이 없거나 확인되지 않는다는 출처 한계 문장을 절대 쓰지 말 것
- URL은 절대 포함하지 않을 것 (시스템이 별도로 추가함)
- 구어체의 친절한 톤을 사용하되 광고성 표현은 피할 것
- 답변 텍스트만 출력할 것 (설명·인사·마크다운 헤더 없이)
- 질문자에게 굳이 필요 없는 면책·한계·검수 설명은 쓰지 말 것

## 질문
제목: ${params.questionTitle}
내용: ${params.questionBody.slice(0, 1000) || '(본문 없음)'}

## 참고 포스트
제목: ${params.articleTitle}
내용: ${params.articleExcerpt.slice(0, 5000)}

위 질문에 맞는 답변을 작성해주세요.`);
}

export async function critiqueKinAnswer(
  params: AnswerParams,
  answerText: string
): Promise<AnswerCritique> {
  if (hasDisallowedMetaLanguage(answerText)) {
    return {
      verdict: 'REWRITE',
      reason: '참고 자료의 한계 설명을 삭제하고 근거가 있는 답변만 직접 작성하세요.',
    };
  }

  const prompt = `당신은 네이버 지식iN 답변 품질 검수자입니다. 사소한 표현 문제로 답변을 폐기하지 말고
아래 세 단계 중 하나로 판정하세요.

## 판정 기준
- PASS: 질문에 직접 답하고 참고 포스트로 핵심 내용을 뒷받침할 수 있음. 사소한 문체 문제는 허용
- REWRITE: 질문과 포스트는 관련 있지만 일반적인 도입, 부수적인 근거 없음, 과도한 단정, 홍보성 표현,
  질문 상황 반영 부족, 길이 문제처럼 답변을 고치면 게시할 수 있음
- REJECT: 질문과 포스트의 대상/기관/서비스/핵심 문제가 다르거나, 포스트로 질문의 중요한 부분을
  해결할 수 없거나, 고쳐 써도 링크가 질문자에게 실질적인 도움이 되지 않음

치명적인 동문서답과 핵심 사실 날조만 REJECT하세요. 포스트에 없는 부수적인 문장이 있으면
REJECT하지 말고 REWRITE로 판정하고 삭제할 내용을 이유에 구체적으로 적으세요.

## 질문
제목: ${params.questionTitle}
내용: ${params.questionBody.slice(0, 1000) || '(본문 없음)'}

## 참고 포스트
제목: ${params.articleTitle}
내용: ${params.articleExcerpt.slice(0, 5000)}

## 검수할 답변
${answerText}

결과를 JSON 객체 하나로만 출력하세요 (설명, 마크다운 없이):
{"verdict": "PASS|REWRITE|REJECT", "reason": "수정 또는 판정 이유"}`;

  const raw = await runCodex(prompt);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: 'REWRITE', reason: `검수 결과 해석 실패: ${raw.slice(0, 200)}` };
  try {
    const parsed = JSON.parse(match[0]);
    const verdict = parsed?.verdict;
    return {
      verdict: verdict === 'PASS' || verdict === 'REJECT' ? verdict : 'REWRITE',
      reason: typeof parsed?.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return { verdict: 'REWRITE', reason: `검수 JSON 해석 실패: ${raw.slice(0, 200)}` };
  }
}

export async function rewriteKinAnswer(
  params: AnswerParams,
  answerText: string,
  critiqueReason: string
): Promise<string> {
  return runCodex(`당신은 네이버 지식iN 답변을 수정하는 편집자입니다.

## 수정 규칙
- 검수 사유에 지적된 문제를 제거하고 질문에 대한 직접적인 결론을 첫 문장에 작성
- 참고 포스트에서 확인되는 내용만 사용하고, 없는 날짜·수치·절차·기관 정보는 삭제
- 질문 전체를 해결할 수 없으면 참고 포스트에서 근거가 있는 해결 방법만 답하고 나머지는 생략
- 참고 내용에 무엇이 없거나 알 수 없다는 출처 한계 및 검수 설명은 삭제
- 자연스러운 2~4문단, 보통 100~300자. 필요한 경우 이 범위보다 짧거나 길어도 됨
- URL, 인사말, 마크다운, 과도한 홍보 문구를 포함하지 않음
- 수정한 답변 텍스트만 출력

## 질문
제목: ${params.questionTitle}
내용: ${params.questionBody.slice(0, 1000) || '(본문 없음)'}

## 참고 포스트
제목: ${params.articleTitle}
내용: ${params.articleExcerpt.slice(0, 5000)}

## 기존 답변
${answerText}

## 검수 사유
${critiqueReason}`);
}

export async function generateVerifiedKinAnswer(params: AnswerParams): Promise<VerifiedAnswer> {
  let answerText = await generateKinAnswer(params);
  for (let rewriteCount = 0; rewriteCount <= MAX_REWRITES; rewriteCount++) {
    const critique = await critiqueKinAnswer(params, answerText);
    if (critique.verdict === 'PASS' || critique.verdict === 'REJECT') {
      return { answerText, critique, rewriteCount };
    }
    if (rewriteCount === MAX_REWRITES) {
      return {
        answerText,
        critique: {
          verdict: 'REJECT',
          reason: `재작성 ${MAX_REWRITES}회 후에도 통과하지 못함: ${critique.reason}`,
        },
        rewriteCount,
      };
    }
    answerText = await rewriteKinAnswer(params, answerText, critique.reason);
  }
  throw new Error('unreachable');
}

export function runCodexPrompt(prompt: string): Promise<string> {
  return runCodex(prompt);
}

export class CodexUsageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexUsageLimitError';
  }
}

function runCodex(prompt: string): Promise<string> {
  const tmpFile = path.join(os.tmpdir(), `codex-kin-${Date.now()}.txt`);

  return new Promise((resolve, reject) => {
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
