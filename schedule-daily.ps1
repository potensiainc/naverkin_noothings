# nothingz-kin daily 작업을 Windows Task Scheduler에 등록
# 실행: PowerShell을 관리자 권한으로 열고 .\schedule-daily.ps1

$taskName = "nothingz-kin-daily"
$projectDir = "C:\kayem\coding\nodong_noothings\nothingz-kin"
$action = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument "/c npm run daily >> `"$projectDir\state\daily.log`" 2>&1" `
  -WorkingDirectory $projectDir

# 매일 오전 9시 실행
$trigger = New-ScheduledTaskTrigger -Daily -At "09:00AM"

$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -RunLevel Highest `
  -Force

Write-Host "Task '$taskName' 등록 완료 — 매일 09:00 자동 실행"
Write-Host "로그: $projectDir\state\daily.log"
Write-Host ""
Write-Host "수동 실행: Start-ScheduledTask -TaskName '$taskName'"
Write-Host "삭제:      Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
