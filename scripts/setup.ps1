# Shorts setup for Windows 10/11: Python envs, ML models, caption fonts, web UI, `shorts` command.
# Safe to re-run. From the repo folder, in PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 [-NoVision]
# Missing tools (FFmpeg, uv, Bun) are installed with winget.
param([switch]$NoVision)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # makes Invoke-WebRequest much faster

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Say($msg) { Write-Host "==> $msg" -ForegroundColor Red -NoNewline; Write-Host "" }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

# ---- Requirements (installed with winget when missing) --------------------------
$need = @(
  @{ Cmd = "ffmpeg"; Id = "Gyan.FFmpeg";   Name = "FFmpeg" },
  @{ Cmd = "uv";     Id = "astral-sh.uv";  Name = "uv (Python manager)" },
  @{ Cmd = "bun";    Id = "Oven-sh.Bun";   Name = "Bun (builds the UI)" }
)
foreach ($n in $need) {
  if (Have $n.Cmd) { continue }
  if ($n.Cmd -eq "bun" -and (Have "node")) { continue }
  if (-not (Have "winget")) { throw "$($n.Name) is missing. Install it (or App Installer from the Microsoft Store for winget) and re-run." }
  Say "Installing $($n.Name) with winget"
  winget install --id $n.Id -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
  if (-not (Have $n.Cmd)) { throw "$($n.Name) was installed but isn't on PATH yet. Open a new PowerShell window and re-run this script." }
}

# ---- Python environments (3.12: wheels exist for faster-whisper, Phonon-2 and mediapipe) ----
function New-Venv($dir, $req) {
  if (-not (Test-Path "$dir\Scripts\python.exe")) { uv venv --python 3.12 $dir; if ($LASTEXITCODE) { throw "uv venv failed" } }
  uv pip install --python "$dir\Scripts\python.exe" -r $req
  if ($LASTEXITCODE) { throw "installing $req failed" }
}
Say "Transcription environment (.venv)"
New-Venv ".venv" "requirements.txt"

if (-not $NoVision) {
  Say "Vision environment (.venv-vision): auto reframe and background replacement"
  New-Venv ".venv-vision" "requirements-vision.txt"
  New-Item -ItemType Directory -Force models | Out-Null
  $base = "https://storage.googleapis.com/mediapipe-models"
  if (-not (Test-Path models\face.tflite)) { Invoke-WebRequest "$base/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite" -OutFile models\face.tflite }
  if (-not (Test-Path models\selfie.tflite)) { Invoke-WebRequest "$base/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite" -OutFile models\selfie.tflite }
}

# ---- Caption fonts (SIL Open Font License, from Google Fonts), served by the app ----
Say "Caption fonts"
New-Item -ItemType Directory -Force static\fonts | Out-Null
$g = "https://github.com/google/fonts/raw/main/ofl"
$fonts = @{
  "Anton-Regular.ttf" = "$g/anton/Anton-Regular.ttf"; "BebasNeue-Regular.ttf" = "$g/bebasneue/BebasNeue-Regular.ttf"
  "Bangers-Regular.ttf" = "$g/bangers/Bangers-Regular.ttf"; "ArchivoBlack-Regular.ttf" = "$g/archivoblack/ArchivoBlack-Regular.ttf"
  "Poppins-Black.ttf" = "$g/poppins/Poppins-Black.ttf"; "Poppins-ExtraBold.ttf" = "$g/poppins/Poppins-ExtraBold.ttf"
  "Montserrat.ttf" = "$g/montserrat/Montserrat%5Bwght%5D.ttf"; "Inter.ttf" = "$g/inter/Inter%5Bopsz,wght%5D.ttf"
}
foreach ($f in $fonts.Keys) {
  if (-not (Test-Path "static\fonts\$f")) {
    try { Invoke-WebRequest $fonts[$f] -OutFile "static\fonts\$f" } catch { Write-Host "  (skipped $f)" }
  }
}

# ---- Web UI -------------------------------------------------------------------------
Say "Building the web UI"
Push-Location web
if (Have "bun") { bun install; bun run build } else { npm install; npx vite build }
if ($LASTEXITCODE) { Pop-Location; throw "building the UI failed" }
Pop-Location

# ---- Git hooks (block media / user data / local paths from commits) -----------------
if (Test-Path .git) { git config core.hooksPath .githooks }

# ---- `shorts` command and Start Menu shortcut ------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $Root) {
  [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $Root), "User")
  Say "Added $Root to your PATH (new terminals can run: shorts)"
}
$lnk = Join-Path ([Environment]::GetFolderPath("Programs")) "Shorts.lnk"
$sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sh.TargetPath = Join-Path $Root ".venv\Scripts\pythonw.exe"
$sh.Arguments = "`"$(Join-Path $Root 'shorts')`""
$sh.WorkingDirectory = $Root
$sh.Description = "Edit, caption and export short-form videos"
$sh.Save()
Say "Start Menu shortcut: Shorts"

Say "Done! Run: shorts   (or open http://127.0.0.1:7377)"
