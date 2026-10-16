<#
.SYNOPSIS
  One-shot setup for the local-ai project (LLM backend, STT backend, frontend).

.DESCRIPTION
  Run from the repo root (the folder containing llm-studio-backend, stt-backend
  and frontend). Safe to re-run: finished steps are skipped or refreshed.

  If PowerShell blocks the script, run it like this instead:
    powershell -ExecutionPolicy Bypass -File .\setup.ps1

.PARAMETER SkipLlamaCpp
  Don't clone/build llama.cpp (e.g. you only use OpenVINO models).

.PARAMETER RebuildLlamaCpp
  Rebuild llama.cpp even if llama-server.exe already exists.

.PARAMETER NonInteractive
  Accept all defaults and skip every prompt (no Hugging Face login).
#>
[CmdletBinding()]
param(
    [switch]$SkipLlamaCpp,
    [switch]$RebuildLlamaCpp,
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# ---------------------------------------------------------------------------
# Project layout — edit here if your folder names differ
# ---------------------------------------------------------------------------
$backends = @(
    @{ Name = "llm-studio-backend";          Port = 8000; Optional = $false },
    @{ Name = "stt-backend-faster-whisper";  Port = 8001; Optional = $false  }
)
$frontendDir = Join-Path $root "frontend"
$llamaDir    = Join-Path $root "llama.cpp"
$llamaExe    = Join-Path $llamaDir "build\bin\Release\llama-server.exe"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
$script:Results    = New-Object System.Collections.ArrayList
$script:StepStatus = "OK"
$script:StepDetail = ""

function Add-Result {
    param([string]$Step, [string]$Status, [string]$Detail = "")
    [void]$script:Results.Add([pscustomobject]@{ Step = $Step; Status = $Status; Detail = $Detail })
}

function Write-Section {
    param([string]$Text)
    Write-Host ""
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Test-Command {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Native commands don't throw on failure in PowerShell — check the exit code ourselves.
function Invoke-Checked {
    param([string]$Description, [scriptblock]$Command)
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed (exit code $LASTEXITCODE)."
    }
}

# Runs one setup step. A failure is recorded and the script moves on, so one
# broken step doesn't hide the status of everything after it. An action can
# set $script:StepStatus = "SKIPPED" (and StepDetail) to report a skip.
function Invoke-Step {
    param([string]$Name, [scriptblock]$Action)
    $script:StepStatus = "OK"
    $script:StepDetail = ""
    Write-Host ""
    Write-Host ">> $Name" -ForegroundColor Yellow
    try {
        & $Action
        Add-Result $Name $script:StepStatus $script:StepDetail
    }
    catch {
        Write-Host "   $($_.Exception.Message)" -ForegroundColor Red
        Add-Result $Name "FAILED" $_.Exception.Message
    }
}

function Read-Default {
    param([string]$Prompt, [string]$Default)
    if ($NonInteractive) { return $Default }
    $value = Read-Host "$Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value.Trim()
}

function Test-CppCompiler {
    if (Test-Command "cl") { return $true }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $found = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        return [bool]$found
    }
    return $false
}

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
Write-Section "Checking prerequisites"

$needsLlamaBuild = (-not $SkipLlamaCpp) -and ($RebuildLlamaCpp -or -not (Test-Path $llamaExe))
$fatalMissing = $false

function Report-Prereq {
    param([string]$Name, [bool]$Ok, [string]$Detail, [string]$Hint, [bool]$Fatal = $true)
    if ($Ok) {
        Write-Host ("  [ OK ]    {0,-16} {1}" -f $Name, $Detail) -ForegroundColor Green
        Add-Result "Prereq: $Name" "OK" $Detail
    }
    elseif ($Fatal) {
        Write-Host ("  [MISSING] {0,-16} {1}" -f $Name, $Detail) -ForegroundColor Red
        Write-Host "            Fix: $Hint" -ForegroundColor DarkGray
        Add-Result "Prereq: $Name" "FAILED" $Detail
        $script:fatalMissing = $true
    }
    else {
        Write-Host ("  [ WARN ]  {0,-16} {1}" -f $Name, $Detail) -ForegroundColor Yellow
        Write-Host "            Fix: $Hint" -ForegroundColor DarkGray
        Add-Result "Prereq: $Name" "WARNING" $Detail
    }
}

# Python 3.10+
$pythonOk = $false
$pythonDetail = "not found on PATH"
if (Test-Command "python") {
    $raw = (& python --version 2>&1 | Out-String).Trim()
    if ($raw -match 'Python (\d+)\.(\d+)') {
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        $pythonOk = ($major -gt 3) -or ($major -eq 3 -and $minor -ge 10)
        $pythonDetail = $raw
        if (-not $pythonOk) { $pythonDetail = "$raw (need 3.10 or newer)" }
        elseif ($minor -ge 13) { $pythonDetail = "$raw (3.13+ may lack prebuilt packages; 3.11/3.12 is safest)" }
    }
    else { $pythonDetail = "could not read version: $raw" }
}
Report-Prereq "Python" $pythonOk $pythonDetail "winget install Python.Python.3.11"

# Node 18+
$nodeOk = $false
$nodeDetail = "not found on PATH"
if (Test-Command "node") {
    $raw = (& node --version 2>&1 | Out-String).Trim()
    if ($raw -match '^v(\d+)') {
        $nodeOk = ([int]$Matches[1] -ge 18)
        $nodeDetail = if ($nodeOk) { $raw } else { "$raw (need 18 or newer)" }
    }
}
Report-Prereq "Node.js" $nodeOk $nodeDetail "winget install OpenJS.NodeJS.LTS"

Report-Prereq "npm" (Test-Command "npm") "" "Reinstall Node.js (npm ships with it)"
Report-Prereq "git"  (Test-Command "git") "" "winget install Git.Git" ($needsLlamaBuild -or $true)

# Only required if llama.cpp actually needs building
Report-Prereq "CMake" (Test-Command "cmake") "" "winget install Kitware.CMake" $needsLlamaBuild
Report-Prereq "C++ compiler" (Test-CppCompiler) "Visual Studio Build Tools (C++ workload) not detected" `
    "winget install Microsoft.VisualStudio.2022.BuildTools  (then add the 'Desktop development with C++' workload)" $needsLlamaBuild

# ffmpeg is only needed for uploading audio files to the OpenVINO STT backend
Report-Prereq "ffmpeg" (Test-Command "ffmpeg") "" "winget install Gyan.FFmpeg  (needed for audio-file transcription)" $false

if ($fatalMissing) {
    Write-Host ""
    Write-Host "Required prerequisites are missing. Install them, open a NEW terminal (so PATH refreshes), and re-run." -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# 2. llama.cpp (cloned as a sibling of the backends — the LLM backend expects it there)
# ---------------------------------------------------------------------------
Write-Section "llama.cpp"

if ($SkipLlamaCpp) {
    Invoke-Step "llama.cpp" { $script:StepStatus = "SKIPPED"; $script:StepDetail = "-SkipLlamaCpp" }
}
else {
    Invoke-Step "Clone llama.cpp" {
        if (Test-Path $llamaDir) {
            $script:StepStatus = "SKIPPED"; $script:StepDetail = "already present"
        }
        else {
            Invoke-Checked "git clone" { & git clone https://github.com/ggml-org/llama.cpp $llamaDir }
        }
    }

    Invoke-Step "Build llama.cpp (can take several minutes)" {
        if ((Test-Path $llamaExe) -and -not $RebuildLlamaCpp) {
            $script:StepStatus = "SKIPPED"; $script:StepDetail = "llama-server.exe already built"
        }
        else {
            Push-Location $llamaDir
            try {
                Invoke-Checked "cmake configure" { & cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="75" }
                Invoke-Checked "cmake build"     { & cmake --build build --config Release -j }
            }
            finally { Pop-Location }
            if (-not (Test-Path $llamaExe)) { throw "Build finished but llama-server.exe was not found at $llamaExe" }
        }
    }
}

# ---------------------------------------------------------------------------
# 3 & 4. Python backends: venv + requirements
# ---------------------------------------------------------------------------
Write-Section "Python backends"

$readyBackends = @()
foreach ($b in $backends) {
    $dir = Join-Path $root $b.Name

    if (-not (Test-Path $dir)) {
        if ($b.Optional) { continue }   # optional backend not present — say nothing
        Add-Result "Backend: $($b.Name)" "FAILED" "folder not found at $dir"
        Write-Host "Folder not found: $dir" -ForegroundColor Red
        continue
    }

    Invoke-Step "Set up $($b.Name)" {
        $requirements = Join-Path $dir "requirements.txt"
        if (-not (Test-Path $requirements)) { throw "requirements.txt not found in $dir" }

        $venvDir    = Join-Path $dir ".venv"
        $venvPython = Join-Path $venvDir "Scripts\python.exe"

        if (-not (Test-Path $venvPython)) {
            Invoke-Checked "venv creation" { & python -m venv $venvDir }
        }

        # setuptools/wheel first: some packages (e.g. webrtcvad) fail to build without them
        Invoke-Checked "pip upgrade" { & $venvPython -m pip install --upgrade pip setuptools wheel }
        Invoke-Checked "pip install -r requirements.txt" { & $venvPython -m pip install -r $requirements }
    }

    $last = $script:Results[$script:Results.Count - 1]
    if ($last.Status -eq "OK") { $readyBackends += $b }
}

# ---------------------------------------------------------------------------
# 5. Frontend
# ---------------------------------------------------------------------------
Write-Section "Frontend"

$frontendReady = $false
if (-not (Test-Path $frontendDir)) {
    Add-Result "Frontend" "FAILED" "folder not found at $frontendDir"
    Write-Host "Folder not found: $frontendDir" -ForegroundColor Red
}
else {
    Invoke-Step "npm install (frontend)" {
        Push-Location $frontendDir
        try { Invoke-Checked "npm install" { & npm install } }
        finally { Pop-Location }
    }
    $frontendReady = ($script:Results[$script:Results.Count - 1].Status -eq "OK")
}

# ---------------------------------------------------------------------------
# 6. Configuration: frontend .env.local + optional Hugging Face login
# ---------------------------------------------------------------------------
Write-Section "Configuration"

if (Test-Path $frontendDir) {
    Invoke-Step "Write frontend/.env.local" {
        $envPath = Join-Path $frontendDir ".env.local"
        $write = $true
        if (Test-Path $envPath) {
            if ($NonInteractive) { $write = $false }
            else {
                $answer = Read-Host ".env.local already exists. Overwrite? (y/N)"
                $write = ($answer -match '^(y|yes)$')
            }
        }

        if (-not $write) {
            $script:StepStatus = "SKIPPED"; $script:StepDetail = "kept existing file"
        }
        else {
            $lines = @()
            foreach ($b in $backends) {
                if ($b.Optional -and -not (Test-Path (Join-Path $root $b.Name))) { continue }
                switch ($b.Name) {
                    "llm-studio-backend"         { $varName = "NEXT_PUBLIC_LLM_API_URL" }
                    "stt-backend-faster-whisper" { $varName = "NEXT_PUBLIC_STT_API_URL" }
                }
                $url = Read-Default "URL for $($b.Name)" "http://localhost:$($b.Port)"
                $lines += "$varName=$url"
            }
            # Write without a BOM — some env parsers choke on one
            [System.IO.File]::WriteAllText($envPath, ($lines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "   Wrote $envPath"
        }
    }
}

# The backends don't read a .env file, so instead of writing the token to one,
# log in once through huggingface_hub — it stores the token where every
# HF download call picks it up automatically.
Invoke-Step "Hugging Face login (optional)" {
    $llmPython = Join-Path $root "llm-studio-backend\venv\Scripts\python.exe"

    if ($NonInteractive) {
        $script:StepStatus = "SKIPPED"; $script:StepDetail = "non-interactive"
    }
    elseif (-not (Test-Path $llmPython)) {
        $script:StepStatus = "SKIPPED"; $script:StepDetail = "LLM backend venv not available"
    }
    else {
        Write-Host "   Only needed for gated models. Press Enter to skip."
        $secure = Read-Host "   Hugging Face token" -AsSecureString
        $token = [System.Net.NetworkCredential]::new("", $secure).Password

        if ([string]::IsNullOrWhiteSpace($token)) {
            $script:StepStatus = "SKIPPED"; $script:StepDetail = "no token entered"
        }
        else {
            # Passed via an environment variable so it never appears on a command line
            $env:HF_SETUP_TOKEN = $token
            try {
                Invoke-Checked "huggingface login" {
                    & $llmPython -c "import os; from huggingface_hub import login; login(token=os.environ['HF_SETUP_TOKEN'])"
                }
            }
            finally { Remove-Item Env:HF_SETUP_TOKEN -ErrorAction SilentlyContinue }
        }
    }
}

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------
Write-Section "Summary"

foreach ($r in $script:Results) {
    $color = switch ($r.Status) {
        "OK"      { "Green" }
        "SKIPPED" { "DarkGray" }
        "WARNING" { "Yellow" }
        default   { "Red" }
    }
    $detail = if ($r.Detail) { "  ($($r.Detail))" } else { "" }
    Write-Host ("  [{0,-7}] {1}{2}" -f $r.Status, $r.Step, $detail) -ForegroundColor $color
}

Write-Host ""
Write-Host "To run the app, run ./start.ps1" -ForegroundColor Cyan

Write-Host ""
Write-Host "Models are not included — download them from the app's download panels on first use." -ForegroundColor DarkGray

$failed = @($script:Results | Where-Object { $_.Status -eq "FAILED" })
if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "$($failed.Count) step(s) failed — see the messages above. Fix the cause and re-run; finished steps are skipped." -ForegroundColor Red
    exit 1
}
exit 0