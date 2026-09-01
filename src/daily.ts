import { chromium } from 'playwright';
import * as path from 'path';
import { config } from './config';
import { fetchYesterdayArticles, Article } from './wordpress';
import { searchKin, readQuestion, checkKinSession } from './kin-search';
import { generateKinAnswer } from './answer-writer';
import { postAnswer } from './kin-editor';
import { normalizeKinUrl, loadAnsweredUrls, appendAnsweredUrl, appendAnswerLog } from './state';

const PROFILE_DIR = path.resolve(__dirname, '../browser-profile');

function buildQueries(article: Article): string[] {
  const title = article.title;
  const tokens = title.split(/[\s·\-·]+/).filter(w => w.length > 1);
  const queries: string[] = [title];
  for (let i = 0; i < tokens.length - 1 && queries.length < config.queriesPerArticle; i++) {
    queries.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return queries.slice(0, config.queriesPerArticle);
}

async function main() {
  const startedAt = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log('[DAILY] 시작:', startedAt);

  // 1. 어제 글 가져오기
  let articles: Article[];
  try {
    articles = await fetchYesterdayArticles();
  } catch (e) {
    console.error('[DAILY] WordPress 글 가져오기 실패:', e);
    process.exit(1);
  }

  if (articles.length === 0) {
    console.log('[DAILY] 어제 발행된 글 없음. 종료.');
    return;
  }
  console.log(`[DAILY] ${articles.length}개 글 처리`);

  // 2. 브라우저 시작
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    args: ['--no-sandbox'],
  });
  const page = await context.newPage();

  // 3. KIN 세션 확인
  const sessionOk = await checkKinSession(page);
  if (!sessionOk) {
    console.error('[DAILY] KIN 세션 만료. 실행 전 npm run auth:naver 필요.');
    await context.close();
    process.exit(1);
  }

  const answeredUrls = loadAnsweredUrls();

  // 4. 글별 처리
  for (const article of articles) {
    console.log(`\n[ARTICLE] [${article.id}] ${article.title}`);
    let answeredCount = 0;
    const queries = buildQueries(article);

    for (const query of queries) {
      if (answeredCount >= config.maxAnswersPerArticle) break;

      console.log(`  쿼리: "${query}"`);
      let results;
      try {
        results = await searchKin(page, query);
      } catch {
        continue;
      }

      for (const result of results) {
        if (answeredCount >= config.maxAnswersPerArticle) break;

        // docId만 추출해 정규화된 URL 생성
        const docIdMatch = result.questionUrl.match(/docId=(\d+)/);
        if (!docIdMatch) continue;
        const docId = docIdMatch[1];
        const cleanUrl = `https://kin.naver.com/qna/detail.naver?docId=${docId}`;
        const key = normalizeKinUrl(cleanUrl);

        if (answeredUrls.has(key)) {
          console.log(`    SKIP (already answered): docId=${docId}`);
          continue;
        }

        // 질문 읽기
        const question = await readQuestion(page, cleanUrl);
        if (!question?.title) {
          console.log(`    SKIP (cannot read): docId=${docId}`);
          continue;
        }

        // claude CLI로 답변 생성
        let answerText: string;
        try {
          console.log(`    답변 생성 중: ${question.title.slice(0, 40)}`);
          answerText = await generateKinAnswer({
            questionTitle: question.title,
            questionBody: question.body ?? '',
            articleTitle: article.title,
            articleUrl: article.permalink,
            articleExcerpt: article.plaintext.slice(0, 500),
          });
        } catch (e) {
          console.error(`    답변 생성 실패:`, e);
          continue;
        }

        // SmartEditor에 등록
        console.log(`    등록 시도: docId=${docId}`);
        const editorResult = await postAnswer(page, cleanUrl, answerText, article.permalink);

        const logEntry = {
          registeredAt: new Date().toISOString(),
          articleTitle: article.title,
          articleUrl: article.permalink,
          questionUrl: cleanUrl,
          queryUsed: query,
          matchType: 'AUTO',
          status: (editorResult.success ? 'SUCCESS' : 'FAILED') as 'SUCCESS' | 'FAILED',
          errorMessage: editorResult.error,
        };

        if (editorResult.success) {
          appendAnsweredUrl(cleanUrl);
          answeredUrls.add(key);
          answeredCount++;
          console.log(`    ✓ SUCCESS answerNo=${editorResult.answerNo}`);
        } else {
          console.log(`    ✗ FAILED: ${editorResult.error}`);
        }

        appendAnswerLog(logEntry);
        await page.waitForTimeout(3000); // 등록 간 간격
      }
    }

    console.log(`  완료: ${answeredCount}/${config.maxAnswersPerArticle}`);
  }

  await context.close();
  console.log('\n[DAILY] 완료:', new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));
}

main().catch(e => {
  console.error('[DAILY] Fatal:', e);
  process.exit(1);
});
