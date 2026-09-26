param(
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$stateDir = Join-Path $projectDir 'state'
$logFile = Join-Path $stateDir 'daily.log'
$lockFile = Join-Path $stateDir 'daily-watchdog.lock'
$retryDelaysSeconds = @(120, 300, 900)
$maxRuns = 4

New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

function Write-WatchdogLog([string]$message) {
    $line = "[WATCHDOG] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
    Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
    Write-Host $line
}

function Get-RecoveryAction([int]$exitCode, [string]$recentLog) {
    if ($exitCode -eq 0) { return 'COMPLETE' }
    if ($exitCode -eq 31 -or $recentLog -match 'requires a newer version of Codex|upgrade to the latest app or CLI') {
        return 'UPGRADE_CODEX'
    }
    if ($exitCode -eq 32 -or $recentLog -match 'not logged in|authentication required|unauthorized') {
        return 'STOP_AUTH'
    }
    if ($exitCode -eq 33 -or $recentLog -match '0xC0000409|BEX64|ECONNRESET|ETIMEDOUT|connection reset') {
        return 'RETRY_TRANSIENT'
    }
    if ($exitCode -eq 34) { return 'STOP_FATAL' }
    return 'RETRY_UNKNOWN'
}

function Send-RecoveryNotification([string]$title, [string]$details) {
    try {
        & npx ts-node src/watchdog-notify.ts $title $details 2>&1 |
            Add-Content -LiteralPath $logFile -Encoding UTF8
    } catch {
        Write-WatchdogLog "Discord 복구 알림 실패: $($_.Exception.Message)"
    }
}

if ($SelfTest) {
    $cases = @(
        @{ Code = 0; Log = ''; Expected = 'COMPLETE' },
        @{ Code = 31; Log = ''; Expected = 'UPGRADE_CODEX' },
        @{ Code = 1; Log = 'requires a newer version of Codex'; Expected = 'UPGRADE_CODEX' },
        @{ Code = 32; Log = ''; Expected = 'STOP_AUTH' },
        @{ Code = 33; Log = ''; Expected = 'RETRY_TRANSIENT' },
        @{ Code = 34; Log = ''; Expected = 'STOP_FATAL' },
        @{ Code = 1; Log = 'unknown failure'; Expected = 'RETRY_UNKNOWN' }
    )
    foreach ($case in $cases) {
        $actual = Get-RecoveryAction $case.Code $case.Log
        if ($actual -ne $case.Expected) {
            throw "Self-test failed: code=$($case.Code), expected=$($case.Expected), actual=$actual"
        }
    }
    Write-Host 'WATCHDOG_SELF_TEST_OK'
    exit 0
}

$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open(
        $lockFile,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
} catch {
    Write-WatchdogLog '다른 자동화 실행이 진행 중이므로 중복 실행을 건너뜁니다.'
    exit 0
}

try {
    $upgradeAttempted = $false
    $unknownRetryUsed = $false

    for ($run = 1; $run -le $maxRuns; $run++) {
        Write-WatchdogLog "일일 작업 시작 ($run/$maxRuns)"
        Push-Location $projectDir
        try {
            & cmd.exe /d /c "npm run daily >> `"$logFile`" 2>&1"
            $dailyExitCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }

        $recentLog = (Get-Content -LiteralPath $logFile -Tail 250 -ErrorAction SilentlyContinue) -join "`n"
        $action = Get-RecoveryAction $dailyExitCode $recentLog
        Write-WatchdogLog "작업 종료 코드=$dailyExitCode, 분석 결과=$action"

        if ($action -eq 'COMPLETE') {
            if ($run -gt 1) {
                Send-RecoveryNotification '자동 복구 성공' "오류 복구 후 $run번째 실행에서 작업이 정상 종료되었습니다."
            }
            exit 0
        }

        if ($action -eq 'UPGRADE_CODEX') {
            if ($upgradeAttempted) {
                Send-RecoveryNotification '자동 복구 실패' 'Codex CLI를 업데이트했지만 버전 오류가 반복되었습니다.'
                exit 31
            }
            $upgradeAttempted = $true
            Write-WatchdogLog 'Codex CLI 버전 불일치 감지 — 최신 버전으로 업데이트합니다.'
            Send-RecoveryNotification 'Codex CLI 자동 업데이트' '모델 호환성 오류를 감지해 최신 CLI 설치 후 작업을 재시작합니다.'
            & npm install -g '@openai/codex@latest' 2>&1 | Add-Content -LiteralPath $logFile -Encoding UTF8
            if ($LASTEXITCODE -ne 0) {
                Send-RecoveryNotification '자동 업데이트 실패' "npm 종료 코드 $LASTEXITCODE"
                exit 31
            }
            & codex --version 2>&1 | Add-Content -LiteralPath $logFile -Encoding UTF8
            Start-Sleep -Seconds 10
            continue
        }

        if ($action -eq 'STOP_AUTH') {
            Send-RecoveryNotification '로그인 필요' 'Codex 인증이 만료되어 자동 재로그인이 불가능합니다. codex login이 필요합니다.'
            exit 32
        }

        if ($action -eq 'STOP_FATAL') {
            Send-RecoveryNotification '복구 불가능 오류' "종료 코드 $dailyExitCode. 로그를 확인해야 합니다."
            exit 34
        }

        if ($action -eq 'RETRY_UNKNOWN') {
            if ($unknownRetryUsed) {
                Send-RecoveryNotification '알 수 없는 오류 반복' "한 차례 재시도 후에도 종료 코드 $dailyExitCode가 반복되었습니다."
                exit $dailyExitCode
            }
            $unknownRetryUsed = $true
        }

        if ($run -ge $maxRuns) {
            Send-RecoveryNotification '재시도 한도 도달' "종료 코드 $dailyExitCode, 총 $maxRuns회 실행 후 중단했습니다."
            exit $dailyExitCode
        }

        $delay = $retryDelaysSeconds[[Math]::Min($run - 1, $retryDelaysSeconds.Count - 1)]
        Write-WatchdogLog "$action 오류 — $delay초 후 같은 일일 상태에서 재시작합니다."
        Send-RecoveryNotification '자동 재시작 예정' "$action 오류를 감지했습니다. $delay초 후 $($run + 1)번째 실행을 시작합니다."
        Start-Sleep -Seconds $delay
    }
} finally {
    if ($lockStream) { $lockStream.Dispose() }
}
