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
내용: ${p.questionBody.slice(0, 500) || '(본문 없음)'}

## 참고 포스트
제목: ${p.articleTitle}
내용: ${p.articleExcerpt.slice(0, 400)}

위 질문에 맞는 답변을 작성해주세요.`;
}

function runCodex(prompt: string): Promise<string> {
  // Write output to a temp file via codex exec -o flag
  const tmpFile = path.join(os.tmpdir(), `codex-kin-${Date.now()}.txt`);

  return new Promise((resolve, reject) => {
    // Use '-' so codex reads the prompt from stdin (avoids shell arg-splitting issues)
    // On Windows, npx resolves the codex shim; shell:true is needed for PATH resolution
    const proc = spawn(
      'codex exec --skip-git-repo-check --approve-for-me' + ` -o "${tmpFile}" -`,
      [],
      { shell: true, windowsHide: true }
    );

    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();

    let errOutput = '';
    proc.stderr?.on('data', (d: Buffer) => { errOutput += d.toString(); });

    proc.on('close', (code: number | null) => {
      try {
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
