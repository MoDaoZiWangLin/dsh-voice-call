# dsh-voice-call — install into the DeepSeek Harness desktop app.
# Syncs the repo into ~/.dsh/plugins/dsh-voice-call, sets up the python engine
# (sherpa-onnx + edge-tts + model, on first run), and wires the plugin into
# the DSH profile(s). A restart of the app is required for the plugin to load.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1            # desktop profile
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Profile all
param(
  [ValidateSet("desktop", "web", "all")]
  [string]$Profile = "desktop",
  [switch]$SetupEngine,
  [switch]$FetchModel
)
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$homeDir = $env:USERPROFILE
$pluginsDir = Join-Path $homeDir ".dsh\plugins"
$target = Join-Path $pluginsDir "dsh-voice-call"

Write-Host "[1/4] syncing repo -> $target"
New-Item -ItemType Directory -Force -Path $target | Out-Null
robocopy $repo $target /MIR /XD ".git" "node_modules" ".venv" "models" /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }

Write-Host "[2/4] python engine"
$py = Join-Path $target "engine\.venv\Scripts\python.exe"
if (-not (Test-Path $py) -or $SetupEngine) {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $target "scripts\setup_engine.ps1")
} else {
  Write-Host "      engine venv already present (skip; use -SetupEngine to force)"
}
$senseDir = Join-Path $target "models\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
$zipDir = Join-Path $target "models\sherpa-onnx-zipformer-zh-en-2023-11-22"
$hasModel = (Test-Path (Join-Path $senseDir "model.int8.onnx")) -or (Test-Path (Join-Path $zipDir "tokens.txt"))
if (-not $hasModel -or $FetchModel) {
  & $py (Join-Path $target "scripts\fetch_model.py")
} else {
  Write-Host "      ASR model already present (skip; use -FetchModel to force)"
}

$profiles = @("desktop", "web") | Where-Object { Test-Path (Join-Path $homeDir ".dsh\profiles\$_\package.json") }
if ($Profile -ne "all") { $profiles = @($Profile) }
if ($profiles.Count -eq 0) { Write-Warning "no matching DSH profile found under $homeDir\.dsh\profiles"; return }

Write-Host "[3/4] wiring profiles: $($profiles -join ', ')"
foreach ($p in $profiles) {
  $pkg = Join-Path $homeDir ".dsh\profiles\$p\package.json"
  if (-not (Test-Path $pkg)) { Write-Warning "skip $p (no package.json)"; continue }
  node (Join-Path $repo "scripts\wire-profile.mjs") $pkg "dsh-voice-call"
  Push-Location (Join-Path $homeDir ".dsh\profiles\$p")
  try {
    pnpm install --prefer-offline
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed in profile $p" }
  } finally {
    Pop-Location
  }
}

Write-Host "[4/4] done."
Write-Host ""
Write-Host "✔ 安装完成！请重启 DSH 桌面应用（插件下次启动生效）。"
Write-Host "  重启后在输入框上方会出现「🐋 语音通话」按钮。"
Write-Host ""
Write-Host "  常见问题："
Write-Host "    - 语音引擎依赖的网络仅在首次安装/下载模型时需要，之后全部本地运行。"
Write-Host "    - 对话模型默认走 volcengine/deepseek-v4-flash，可在插件配置里改。"
Write-Host "    - 卸载：scripts\uninstall.ps1"
