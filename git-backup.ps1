param(
    [string]$Message = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".git")) {
    throw "当前目录不是 Git 仓库。"
}

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = "backup: $stamp"
}

git add -A
$changes = git status --porcelain
if ($changes) {
    git commit -m $Message
    Write-Host "Git 备份完成: $Message" -ForegroundColor Green
} else {
    Write-Host "没有需要备份的新改动。" -ForegroundColor Yellow
}
