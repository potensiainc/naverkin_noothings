# nothingz-kin daily 작업을 Windows Task Scheduler에 등록
# 실행: PowerShell을 관리자 권한으로 열고 .\schedule-daily.ps1
#
# 중요: daily.ts / auth-naver.ts는 headless:false로 Chrome을 띄운다.
# Task Scheduler가 Session 0(비대화형 세션)에서 실행하면 Chrome이 화면을
# 못 얻어 세션 체크가 매번 실패한다("KIN 세션 만료"). 그래서 Interactive
# 로그온으로 등록한다 — 그 시각에 PC가 켜져 있고 해당 계정으로 로그인된
# 상태여야 실행된다 (잠금화면/로그아웃 상태면 스킵됨).
#
# 답변 등록 성공마다 42/27/72분을 순환 대기하므로(daily.ts 참고) 글이
# 여러 개면 실행 시간이 몇 시간에 이를 수 있다. ExecutionTimeLimit을
# 넉넉히 12시간으로 잡아 그 안에 강제 종료되지 않게 한다.

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin = $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

$taskName = "nothingz-kin-daily"
$projectDir = "D:\naverkin_noothings"
$action = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument "/c npm run daily >> `"$projectDir\state\daily.log`" 2>&1" `
  -WorkingDirectory $projectDir

# 매일 12:00, 17:00, 21:00 실행
$triggers = @(
    New-ScheduledTaskTrigger -Daily -At "12:00PM"
    New-ScheduledTaskTrigger -Daily -At "05:00PM"
    New-ScheduledTaskTrigger -Daily -At "09:00PM"
)

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Hours 12) `
  -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Principal $principal `
  -Force -ErrorAction Stop

Write-Host "Task '$taskName' 등록 완료 — 매일 12:00, 17:00, 21:00 자동 실행 (Interactive)"
Write-Host "로그: $projectDir\state\daily.log"
Write-Host ""
Write-Host "수동 실행: Start-ScheduledTask -TaskName '$taskName'"
Write-Host "삭제:      Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
