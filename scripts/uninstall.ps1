# dsh-voice-call — uninstall from the DeepSeek Harness desktop app.
# Removes the plugin entry from the DSH profile(s); optionally deletes the
# installed copy under ~/.dsh/plugins (kept by default).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -DeleteFiles
param(
  [ValidateSet("desktop", "web", "all")]
  [string]$Profile = "desktop",
  [switch]$DeleteFiles
)
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$homeDir = $env:USERPROFILE

$profiles = @("desktop", "web") | Where-Object { Test-Path (Join-Path $homeDir ".dsh\profiles\$_\package.json") }
if ($Profile -ne "all") { $profiles = @($Profile) }

foreach ($p in $profiles) {
  $pkg = Join-Path $homeDir ".dsh\profiles\$p\package.json"
  if (-not (Test-Path $pkg)) { continue }
  node (Join-Path $repo "scripts\unwire-profile.mjs") $pkg "dsh-voice-call"
  Push-Location (Join-Path $homeDir ".dsh\profiles\$p")
  try {
    pnpm install --prefer-offline
  } finally {
    Pop-Location
  }
}

if ($DeleteFiles) {
  $target = Join-Path $homeDir ".dsh\plugins\dsh-voice-call"
  if (Test-Path $target) {
    Remove-Item -Recurse -Force $target
    Write-Host "removed $target"
  }
}

Write-Host "✔ 已从 DSH profile 移除 dsh-voice-call，重启后生效。"
