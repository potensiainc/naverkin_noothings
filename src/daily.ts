import { chromium } from 'playwright';
import * as path from 'path';
import { config } from './config';
import { fetchYesterdayArticles, fetchAllPublishedArticles, Article } from './wordpress';
import { searchKin, readQuestion, checkKinSession } from './kin-search';
import { generateKinAnswer, critiqueKinAnswer, CodexUsageLimitError } from './answer-writer';
import { postAnswer } from './kin-editor';
import { normalizeKinUrl, loadAnsweredUrls, isUrlAnswered, appendAnsweredUrl, appendAnswerLog } from './state';
import { extractSearchQueries, matchArticleToQuestion } from './keyword-matcher';
import {
  buildArticlePlan,
  getKstDateKey,
  loadDailyGoalState,
  remainingDailyAnswers,
  saveDailyGoalState,
} from './daily-plan';

const PROFILE_DIR = path.resolve(__dirname, '../browser-profile');

// DIRECT/SAME_PROBLEM/ADJACENT_ANSWERABLE are all answerable; only
// UNRELATED is skipped. The bar is "not a non-sequitur", not "exact match" —
// volume matters here as long as the article stays roughly on-topic for the
// question. matchArticleToQuestion() itself still cross-checks two
// independent judgments and falls back to the more conservative one on
// disagreement, so this wider gate isn't operating on a single noisy call.
const ANSWERABLE_MATCH_TYPES = new Set(['DIRECT', 'SAME_PROBLEM', 'ADJACENT_ANSWERABLE']);

// After a successful answer, wait this long before attempting the next one.
// Posting on a fixed cadence (e.g. always N minutes) is a bot signature;
// cycling through a few distinct, non-uniform delays makes the interval
// itself less obviously mechanical while still bounding total runtime.
const POST_SUCCESS_DELAYS_MIN = [42, 27, 72];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const startedAt = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log('[DAILY] 시작:', startedAt);

  // 1. 어제 글을 우선하고, 일일 처리 글이 10개 미만이면 전체 발행 글에서 보충한다.
  let articles: Article[];
  const dateKey = getKstDateKey();
  const dailyGoalState = loadDailyGoalState(dateKey);
  try {
    const yesterdayArticles = await fetchYesterdayArticles();
    const allArticles = await fetchAllPublishedArticles();

    if (dailyGoalState.articleIds.length > 0) {
      const byId = new Map(allArticles.map(article => [article.id, article]));
      articles = dailyGoalState.articleIds
        .map(id => byId.get(id))
        .filter((article): article is Article => !!article);
    } else {
      articles = buildArticlePlan(
        yesterdayArticles,
        allArticles,
        config.minimumDailyArticlePool
      );
      dailyGoalState.articleIds = articles.map(article => article.id);
      saveDailyGoalState(dailyGoalState);
    }
  } catch (e) {
    console.error('[DAILY] WordPress 글 가져오기 실패:', e);
    process.exit(1);
  }

  const remainingAtStart = remainingDailyAnswers(config.dailyAnswerGoal, dailyGoalState.successfulAnswers);
  if (remainingAtStart === 0) {
    console.log(`[DAILY] 오늘 목표 ${config.dailyAnswerGoal}건 이미 달성. 종료.`);
    return;
  }
  if (articles.length === 0) {
    console.log('[DAILY] 처리할 발행 글 없음. 종료.');
    return;
  }
  console.log(`[DAILY] ${articles.length}개 글 처리 — 오늘 ${dailyGoalState.successfulAnswers}/${config.dailyAnswerGoal}건, 남은 목표 ${remainingAtStart}건`);

  // 2. 브라우저 시작
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
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
  let delayIndex = 0; // cycles through POST_SUCCESS_DELAYS_MIN after each success
  let stoppedForUsageLimit = false;

  try {
    // 4. 글별 처리
    for (const article of articles) {
      if (remainingDailyAnswers(config.dailyAnswerGoal, dailyGoalState.successfulAnswers) === 0) break;
      console.log(`\n[ARTICLE] [${article.id}] ${article.title}`);
      let answeredCount = 0;

      let queries: string[];
      try {
        queries = await extractSearchQueries(article, config.queriesPerArticle);
        console.log(`  키워드: ${queries.join(', ')}`);
      } catch (e) {
        if (e instanceof CodexUsageLimitError) throw e;
        console.error(`  키워드 도출 실패, 글 스킵:`, e);
        continue;
      }

      for (const query of queries) {
        if (remainingDailyAnswers(config.dailyAnswerGoal, dailyGoalState.successfulAnswers) === 0) break;
        if (answeredCount >= config.maxAnswersPerArticle) break;

        console.log(`  쿼리: "${query}"`);
        // 네이버 지식iN 검색이 실제로 지원하는 정렬은 정확도(none)/
        // 최신순(date)/추천순(vcount) 세 가지뿐이다. "미답변순"이라는
        // 정렬은 존재하지 않는데, 이전에 sort=answer라는 값을 임의로
        // 만들어 병행 검색을 시도한 적이 있다 — 네이버는 인식 못 하는
        // sort 값에 완전히 빈 페이지로 응답하고, 게다가 그 병행 호출을
        // Promise.all로 같은 page 객체에 동시 실행하는 바람에 두
        // 네비게이션이 서로의 실행 컨텍스트를 깨뜨려 정상적인 date
        // 검색 결과까지 0건이 되는 레이스 컨디션까지 겹쳤다. 그 결과
        // 실제로 하루 전체 실행에서 단 한 건도 등록되지 못한 사고가
        // 있었다. 존재가 확인된 최신순만 사용한다.
        let results;
        try {
          results = await searchKin(page, query, 'date');
        } catch (e) {
          console.error(`    검색 실패, 다음 쿼리로: ${e}`);
          continue;
        }
        console.log(`    검색 결과 ${results.length}건`);

        for (const result of results) {
          if (remainingDailyAnswers(config.dailyAnswerGoal, dailyGoalState.successfulAnswers) === 0) break;
          if (answeredCount >= config.maxAnswersPerArticle) break;

          // dirId가 없으면 detail.naver가 "유효하지 않은 요청"으로 거부하므로
          // 검색 결과가 만든 완전한 URL(dirId 포함)을 그대로 사용한다.
          const docId = result.docId;
          const cleanUrl = result.questionUrl;
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

          // 이 질문의 카테고리 자체가 일반 회원 답변을 막아두는 경우
          // (정부기관 FAQ 전용 dirId 등) 매칭/생성 codex 호출은 의미가
          // 없다 — 아무리 잘 맞는 글이라도 등록 시 네이버가 "답변이
          // 허용되지 않는 디렉토리입니다" 다이얼로그로 거부한다. readQuestion이
          // 이미 실제로 답변 버튼을 클릭해 확인했으므로 여기서 바로 스킵한다.
          if (!question.answerable) {
            console.log(`    SKIP (답변 불가 디렉토리): ${question.title.slice(0, 40)}`);
            continue;
          }

          // 글-질문 적합성 판단 (DIRECT/SAME_PROBLEM/ADJACENT_ANSWERABLE만 진행)
          let matchType: string;
          try {
            const match = await matchArticleToQuestion(article, question);
            matchType = match.matchType;
            if (!ANSWERABLE_MATCH_TYPES.has(matchType)) {
              console.log(`    SKIP (${matchType}): ${question.title.slice(0, 40)} — ${match.reason}`);
              continue;
            }
            console.log(`    매칭: ${matchType}${match.agreed ? '' : ' (판단 불일치, 보수적 채택)'} — ${match.reason}`);
          } catch (e) {
            if (e instanceof CodexUsageLimitError) throw e;
            console.error(`    매칭 판단 실패, 스킵: docId=${docId}`, e);
            continue;
          }

          // codex CLI로 답변 생성
          const answerParams = {
            questionTitle: question.title,
            questionBody: question.body ?? '',
            articleTitle: article.title,
            articleUrl: article.permalink,
            articleExcerpt: article.plaintext.slice(0, 2000),
          };
          let answerText: string;
          try {
            console.log(`    답변 생성 중: ${question.title.slice(0, 40)}`);
            answerText = await generateKinAnswer(answerParams);
          } catch (e) {
            if (e instanceof CodexUsageLimitError) throw e;
            console.error(`    답변 생성 실패:`, e);
            continue;
          }

          // 자체 품질 검수 — 형식만 보는 에디터 게이트와 달리 실제로 질문에
          // 답이 되는지, 근거 없는 내용을 지어내지 않았는지 다시 판단한다.
          try {
            const critique = await critiqueKinAnswer(answerParams, answerText);
            if (!critique.passes) {
              console.log(`    SKIP (품질 검수 불합격): ${critique.reason}`);
              continue;
            }
          } catch (e) {
            if (e instanceof CodexUsageLimitError) throw e;
            console.error(`    품질 검수 실패, 스킵: docId=${docId}`, e);
            continue;
          }

          // 대기하는 동안 다른 실행이 먼저 답변했을 수 있으므로, 실제
          // 등록 직전에 디스크에서 다시 한 번 중복 여부를 확인한다.
          if (isUrlAnswered(cleanUrl)) {
            console.log(`    SKIP (등록 직전 재확인 결과 이미 답변됨): docId=${docId}`);
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
            matchType,
            status: (editorResult.success ? 'SUCCESS' : 'FAILED') as 'SUCCESS' | 'FAILED',
            errorMessage: editorResult.error,
          };

          if (editorResult.success) {
            appendAnsweredUrl(cleanUrl);
            answeredUrls.add(key);
            answeredCount++;
            dailyGoalState.successfulAnswers++;
            saveDailyGoalState(dailyGoalState);
            console.log(`    ✓ SUCCESS answerNo=${editorResult.answerNo} — 오늘 ${dailyGoalState.successfulAnswers}/${config.dailyAnswerGoal}건`);
            appendAnswerLog(logEntry);

            // 일일 목표를 채웠으면 다음 실행까지 기다리지 않고 즉시 종료한다.
            // 목표가 남았을 때만 42→27→72분 간격을 순환한다.
            if (remainingDailyAnswers(config.dailyAnswerGoal, dailyGoalState.successfulAnswers) > 0) {
              const delayMin = POST_SUCCESS_DELAYS_MIN[delayIndex % POST_SUCCESS_DELAYS_MIN.length];
              delayIndex++;
              console.log(`    다음 답변까지 ${delayMin}분 대기...`);
              await sleep(delayMin * 60 * 1000);
            }
          } else {
            console.log(`    ✗ FAILED: ${editorResult.error}`);
            appendAnswerLog(logEntry);
            await page.waitForTimeout(3000); // 실패 시에는 짧게만 대기하고 다음 후보로
          }
        }
      }

      console.log(`  완료: ${answeredCount}/${config.maxAnswersPerArticle}`);
    }
  } catch (e) {
    if (e instanceof CodexUsageLimitError) {
      // codex 사용량 한도 도달 — 오늘 작업만 여기서 조용히 종료한다.
      // 상태 파일(answered_urls.txt)에는 실제로 성공한 답변만 기록돼 있으므로
      // 내일 스케줄된 실행은 오늘 못 끝낸 나머지를 기존 워크플로우 그대로
      // 이어서 시도하게 된다 (재시도를 위한 별도 상태 저장 불필요).
      stoppedForUsageLimit = true;
      console.error('\n[DAILY] codex 사용량 한도 도달 — 오늘 작업 종료. 내일 예약 실행에서 이어서 진행됩니다.', e.message);
    } else {
      throw e;
    }
  }

  await context.close();
  console.log(
    '\n[DAILY] 완료:',
    new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    stoppedForUsageLimit ? '(사용량 한도로 조기 종료)' : ''
  );
}

main().catch(e => {
  console.error('[DAILY] Fatal:', e);
  process.exit(1);
});
