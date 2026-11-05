# 创建代码备份（不包含 node_modules、models 和 backups，避免递归和备份过大）
$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $PSScriptRoot 'backups'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$dest = Join-Path $backupDir "backup-$stamp.tar.gz"
tar -czf $dest --exclude=node_modules --exclude=models --exclude=backups -C $PSScriptRoot .
Write-Host "备份完成: $dest"
