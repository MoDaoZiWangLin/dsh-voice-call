# dsh-voice-call engine setup: venv + sherpa-onnx(STT) + edge-tts(TTS) + model download
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$engine = Join-Path $root "engine"
$venv = Join-Path $engine ".venv"
$py = Join-Path $venv "Scripts\python.exe"

Write-Host "[1/4] creating venv at $venv"
if (-not (Test-Path $py)) {
  python -m venv $venv
  if (-not (Test-Path $py)) { throw "venv creation failed" }
}

Write-Host "[2/4] pip install sherpa-onnx edge-tts (may take a while)"
& $py -m pip install --upgrade pip --quiet
& $py -m pip install sherpa-onnx edge-tts
if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit $LASTEXITCODE)" }

Write-Host "[3/4] verify imports"
& $py -c "import sherpa_onnx, edge_tts; print('sherpa-onnx', sherpa_onnx.__version__); print('edge-tts ok')"
if ($LASTEXITCODE -ne 0) { throw "import check failed" }

Write-Host "[4/4] done. engine ready."
