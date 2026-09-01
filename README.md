# nothingz-kin

NOOTHINGS × NAVER 지식iN Traffic Automation MVP

## 목적

매일 실행 시 noothings.kr 전일 신규 글을 찾아 관련 네이버 지식iN 질문에 자연스러운 답변을 자동 등록한다.

## 요구 환경

- Node.js 18+
- Naver 계정 (persistent browser profile 또는 `.env.local` credentials)
- Playwright 브라우저 설치 필요

## 설치

```bash
npm install
npx playwright install chromium
```

## 인증 설정

### 방법 1: 수동 최초 로그인 (권장)

```bash
npm run auth:naver
```

브라우저가 열리면 Naver에 직접 로그인한다. 세션이 `browser-profile/`에 저장되어 이후 자동 실행 시 재사용된다.

### 방법 2: .env.local 자격증명 (세션 만료 시 자동 재로그인)

프로젝트 루트(`nodong_noothings/`)에 `.env.local` 파일 생성:

```
NAVER_ID=네이버아이디
NAVER_PASSWORD=네이버비밀번호
```

세션이 만료되면 자동으로 1회 재로그인 시도한다. CAPTCHA/OTP가 발생하면 즉시 중단하고 `AUTH_REQUIRES_HUMAN` 오류를 반환한다. 그 경우 `npm run auth:naver`로 수동 로그인이 필요하다.

> **보안 주의**: `.env.local`은 Git에 커밋하지 않는다 (`.gitignore` 적용됨).  
> `browser-profile/`도 Git에 커밋하지 않는다.

## Config

`config.json`:

| 키 | 기본값 | 설명 |
|---|---|---|
| site | https://noothings.kr | WordPress 사이트 URL |
| timezone | Asia/Seoul | 기준 타임존 |
| queriesPerArticle | 8 | 글당 검색 Query 수 |
| resultsPerQuery | 12 | Query당 결과 수 |
| maxAnswersPerArticle | 5 | 글당 최대 답변 등록 수 |
| submitRetry | 1 | 등록 실패 시 재시도 횟수 |
| navigationRetry | 1 | 페이지 이동 실패 시 재시도 횟수 |
| autoSubmit | true | 자동 등록 여부 |
| kinBaseUrl | https://kin.naver.com/ | 지식iN 직접 진입 URL |

## 실행 방법

### 운영 실행

```bash
npm run run
```

### Dry-run (답변 등록 없이 검증만)

```bash
npm run dry-run
```

## 인증 흐름

1. Playwright가 `browser-profile/`의 persistent context로 `https://kin.naver.com/`에 직접 접속
2. KIN DOM에서 세션 상태 확인
   - **SESSION_VALID** → 즉시 진행 (credentials 불필요)
   - **SESSION_EXPIRED** → `.env.local`에서 NAVER_ID/NAVER_PASSWORD 로드 → 1회 자동 로그인 시도
3. CAPTCHA/OTP/기기 확인 등 추가 인증 발생 → `AUTH_REQUIRES_HUMAN` → 즉시 중단
4. 로그인 성공 후 KIN에서 재검증

> Playwright는 항상 `https://kin.naver.com/`으로 직접 이동한다. Naver 메인 또는 검색을 통해 지식iN에 진입하지 않는다.

## State 파일

| 파일 | 설명 |
|---|---|
| `state/answered_urls.txt` | 이미 답변한 질문 ID (등록 성공 후에만 기록) |
| `state/answer_log.csv` | 전체 실행 로그 |

## 테스트

```bash
npm test
```

## 장애 발생 시 행동

1. `artifacts/failures/` 에 스크린샷과 로그 확인
2. `state/answer_log.csv`의 FAILED 행 확인
3. 해당 Question URL을 수동으로 확인

## CAPTCHA · AUTH_REQUIRES_HUMAN 발생 시

프로그램이 즉시 자동 중단된다. 절대로 CAPTCHA를 우회하지 않는다.

```bash
npm run auth:naver   # 브라우저에서 수동 로그인 후 재실행
```

## autoSubmit 설정

`config.json`에서 `autoSubmit: true`이면 Final Editor Gate PASS 후 즉시 자동 등록된다.

개발/검증 시에는 `DRY_RUN=true npm run run` 또는 `npm run dry-run`을 사용한다.
