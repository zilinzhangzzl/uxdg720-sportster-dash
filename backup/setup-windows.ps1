# 一键配置 GitHub 自动备份（Windows）
# 由 setup-windows.bat 调用。只需运行一次；重复运行也安全。
#
# 做什么：
#   1. 检查 Git for Windows
#   2. 初始化本地仓库并连接 GitHub 仓库
#   3. 首次提交并上传（第一次会弹出浏览器让你登录 GitHub，登录信息由 Windows 凭据管理器保存，不写入项目）
#   4. 创建每 10 分钟运行一次的 Windows 计划任务（后台隐藏运行）
#
# 不会强制覆盖远程内容；远程已有不同的内容时会停下并说明。

param(
  [string]$RepoUrl = 'https://github.com/zilinzhangzzl/uxdg720-sportster-dash.git'
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$ProjectDir = Split-Path -Parent $PSScriptRoot
$TaskName   = 'UXDG720 Sportster Backup'
$Branch     = 'main'

function Step($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   $m" -ForegroundColor Green }
function Fail($m) {
  Write-Host ""
  Write-Host "[未完成] $m" -ForegroundColor Red
  Write-Host "自动备份尚未启用。处理后可以重新双击 setup-windows.bat。" -ForegroundColor Yellow
  Read-Host "按回车关闭"
  exit 1
}

Set-Location $ProjectDir
Write-Host "项目文件夹：$ProjectDir"
Write-Host "GitHub 仓库：$RepoUrl"

# ---------- 1. Git ----------
Step '检查 Git'
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) { Fail '没有找到 Git。请先安装 Git for Windows（https://git-scm.com），安装时保持默认选项，然后重新运行。' }
$dir = Split-Path -Parent $gitCmd.Source
$bash = $null
for ($i = 0; $i -lt 4 -and $dir; $i++) {
  $candidate = Join-Path $dir 'bin\bash.exe'
  if (Test-Path $candidate) { $bash = $candidate; break }
  $dir = Split-Path -Parent $dir
}
if (-not $bash) { Fail "找到了 git（$($gitCmd.Source)），但没有找到 Git Bash。请重新安装 Git for Windows。" }
Ok "$(git --version)"
Ok "Git Bash：$bash"

# ---------- 2. 本地仓库 ----------
Step '准备本地仓库'
if (-not (Test-Path (Join-Path $ProjectDir '.git'))) {
  git init -q
  if ($LASTEXITCODE -ne 0) { Fail 'git init 失败。' }
  git symbolic-ref HEAD "refs/heads/$Branch"
  Ok '已创建本地仓库'
} else {
  Ok '本地仓库已存在'
}
git config core.quotepath false
git config core.autocrlf false
if (-not (git config user.name))  { git config user.name 'zilinzhangzzl'; Ok '提交作者名：zilinzhangzzl（只对本项目生效）' }
if (-not (git config user.email)) { git config user.email 'zilinzhangzzl@users.noreply.github.com'; Ok '提交邮箱：GitHub 隐私邮箱（只对本项目生效）' }

$existing = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) { git remote set-url origin $RepoUrl } else { git remote add origin $RepoUrl }
Ok "远程仓库：$RepoUrl"

$current = git symbolic-ref --short HEAD 2>$null
if ($current -ne $Branch) { Fail "当前分支是 '$current'，不是 $Branch。请先告诉 Claude 这个情况。" }

if (git status --porcelain) {
  git add -A
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
  git commit -q -m "初始版本 ${stamp}：仪表盘原型、说明书和备份配置" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`nClaude-Session: https://claude.ai/code/session_019ZjDxTshjzCwEARvddLzZH"
  if ($LASTEXITCODE -ne 0) { Fail '首次提交失败。' }
  Ok '已创建提交'
} else {
  Ok '没有需要提交的新变化'
}

# ---------- 3. 首次上传 ----------
Step '连接 GitHub（第一次会弹出浏览器登录窗口，请在浏览器中登录并授权 Git Credential Manager）'
$remoteHeads = git ls-remote --heads origin $Branch
if ($LASTEXITCODE -ne 0) {
  Fail '无法连接 GitHub 仓库。可能是没有完成登录、仓库地址不对，或网络问题。'
}
if ($remoteHeads) {
  git fetch -q origin
  git merge-base --is-ancestor "origin/$Branch" HEAD
  if ($LASTEXITCODE -ne 0) {
    Fail "GitHub 仓库里已经有本地没有的内容（例如创建仓库时勾选了 README）。为避免覆盖，脚本已停止。最简单的处理：在 GitHub 删除这个仓库，重新建一个空仓库（不勾选任何初始文件），再运行本脚本。"
  }
  Ok 'GitHub 上的内容已包含在本地，可以继续'
}
git push -u origin $Branch
if ($LASTEXITCODE -ne 0) { Fail '上传失败。请确认浏览器登录已完成，并且登录的是 zilinzhangzzl 账号。' }
Ok '已上传到 GitHub'

# ---------- 4. 计划任务 ----------
Step '创建每 10 分钟运行一次的计划任务'
$script = (Join-Path $PSScriptRoot 'auto-backup.sh') -replace '\\', '/'
$vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
$vbsText = @"
' 由 setup-windows.ps1 生成：在后台隐藏运行自动备份脚本，不弹出黑色窗口。
Set sh = CreateObject("WScript.Shell")
sh.Run """$bash"" -l ""$script""", 0, True
"@
[System.IO.File]::WriteAllText($vbs, $vbsText, [System.Text.Encoding]::Unicode)

try {
  $action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
  $trigger  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description '每 10 分钟检查 UXDG720 仪表盘原型文件，有变化才提交并上传到 GitHub。' -Force -ErrorAction Stop | Out-Null
} catch {
  Fail "创建计划任务失败：$($_.Exception.Message)"
}
Ok "已创建计划任务：$TaskName"

Write-Host ""
Write-Host "配置完成，但还没有验证。" -ForegroundColor Green
Write-Host "回到 Claude 对话说一声“配置完成”，Claude 会修改一个文件并检查它是否在 10 分钟内自动出现在 GitHub 上。"
Write-Host "运行记录：backup\backup.log"
Write-Host "停用自动备份：双击 backup\uninstall-windows.bat"
Read-Host "按回车关闭"
