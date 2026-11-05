param(
    [string]$RepoName = "gas-stove-ignition-inspection",
    [ValidateSet("public", "private")]
    [string]$Visibility = "public"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "=== Upload project to GitHub ===" -ForegroundColor Cyan
Write-Host "Project: $PSScriptRoot"
Write-Host "Repo name: $RepoName"
Write-Host "Visibility: $Visibility"
Write-Host ""

# 1. Check git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git not found. Please install Git for Windows first."
}

# 2. Ensure git repository
if (-not (Test-Path ".git")) {
    git init
    git branch -M main
}

# 3. License reminder
if (-not (Test-Path "LICENSE")) {
    Write-Warning "LICENSE not found. If this repo includes an Ultralytics model, AGPL-3.0 is recommended."
}

# 4. Commit local changes
Write-Host "[1/4] Committing local changes..." -ForegroundColor Yellow
git add -A
$changes = git status --porcelain
if ($changes) {
    $msg = "Update: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    git commit -m $msg
} else {
    Write-Host "No new changes to commit."
}

# 5. Check GitHub CLI
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "GitHub CLI not found. Install it first:" -ForegroundColor Red
    Write-Host "  winget install --id GitHub.cli -e" -ForegroundColor Cyan
    Write-Host "Then reopen PowerShell and run this script again."
    exit 1
}

# 6. Check authentication
Write-Host "[2/4] Checking GitHub authentication..." -ForegroundColor Yellow
gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "GitHub is not logged in or the token is invalid. Starting login..." -ForegroundColor Yellow
    gh auth login --hostname github.com --git-protocol https --web
}

$gitUser = gh api user --jq .login
if (-not $gitUser) {
    throw "Cannot get GitHub username. Please run: gh auth login"
}
$fullName = "$gitUser/$RepoName"
Write-Host "GitHub account: $gitUser"

# 7. Create repo or bind existing repo
Write-Host "[3/4] Checking remote repository $fullName ..." -ForegroundColor Yellow
gh repo view $fullName *> $null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Remote repository exists. Binding origin and pushing."
    $hasOrigin = git remote get-url origin 2>$null
    if ($LASTEXITCODE -eq 0) {
        git remote set-url origin "https://github.com/$fullName.git"
    } else {
        git remote add origin "https://github.com/$fullName.git"
    }
    git push -u origin main
} else {
    Write-Host "Remote repository does not exist. Creating a new repository."
    if ($Visibility -eq "public") {
        gh repo create $RepoName --public --source=. --remote=origin --push --description "Gas stove ignition realtime inspection: FFmpeg + ONNX Runtime DirectML + WebSocket + 1080p30"
    } else {
        gh repo create $RepoName --private --source=. --remote=origin --push --description "Gas stove ignition realtime inspection: FFmpeg + ONNX Runtime DirectML + WebSocket + 1080p30"
    }
}

Write-Host ""
Write-Host "[4/4] Done!" -ForegroundColor Green
Write-Host "Repository: https://github.com/$fullName" -ForegroundColor Cyan
Write-Host ""
Write-Host "License note: this repo includes an Ultralytics-exported model and is released under AGPL-3.0."
