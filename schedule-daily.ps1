# nothingz-kin daily 작업을 Windows Task Scheduler에 등록
# 실행: PowerShell을 관리자 권한으로 열고 .\schedule-daily.ps1
#
# 중요: daily.ts / auth-naver.ts는 headless:false로 Chrome을 띄운다.
# Task Scheduler가 Session 0(비대화형 세션)에서 실행하면 Chrome이 화면을
# 못 얻어 세션 체크가 매번 실패한다("KIN 세션 만료"). 그래서 Interactive
# 로그온으로 등록한다 — 그 시각에 PC가 켜져 있고 해당 계정으로 로그인된
# 상태여야 실행된다 (잠금화면/로그아웃 상태면 스킵됨).

$taskName = "nothingz-kin-daily"
$projectDir = "D:\naverkin_noothings"
$action = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument "/c npm run daily >> `"$projectDir\state\daily.log`" 2>&1" `
  -WorkingDirectory $projectDir

# 매일 09:00 실행
$trigger = New-ScheduledTaskTrigger -Daily -At "09:00AM"

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force

Write-Host "Task '$taskName' 등록 완료 — 매일 09:00 자동 실행 (Interactive)"
Write-Host "로그: $projectDir\state\daily.log"
Write-Host ""
Write-Host "수동 실행: Start-ScheduledTask -TaskName '$taskName'"
Write-Host "삭제:      Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
