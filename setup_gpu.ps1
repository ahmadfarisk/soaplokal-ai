<#
.SYNOPSIS
  One-shot setup for the local-ai project WITH NVIDIA GPU (CUDA) acceleration.

.DESCRIPTION
  A complete setup on its own: you do NOT need to run setup_cpu.ps1 first.
  Use this on machines with an NVIDIA GPU; use setup_cpu.ps1 on machines without.

  Compared with the CPU setup:
    - llama.cpp is installed as a CUDA build. By default this is a prebuilt
      download, so no git, CMake, compiler or CUDA Toolkit is needed for it.
    - The NVIDIA cuBLAS/cuDNN libraries are installed into any STT backend
      venv that uses faster-whisper.

  Run from the repo root. Safe to re-run: finished steps are skipped or refreshed.

  If PowerShell blocks the script, run it like this instead:
    powershell -ExecutionPolicy Bypass -File .\setup_gpu.ps1

.PARAMETER BuildFromSource
  Clone and build llama.cpp with CUDA yourself instead of downloading a
  prebuilt one. Needs git, CMake, Visual Studio Build Tools and the CUDA Toolkit.

.PARAMETER ReinstallLlamaCpp
  Reinstall the llama.cpp CUDA build even if CUDA support is already detected.

.PARAMETER NonInteractive
  Accept all defaults and skip every prompt (no Hugging Face login).
#>
[CmdletBinding()]
param(
    [switch]$BuildFromSource,
    [switch]$ReinstallLlamaCpp,
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
$releaseDir  = Join-Path $llamaDir "build\bin\Release"   # where the LLM backend looks for llama-server.exe
$llamaExe    = Join-Path $releaseDir "llama-server.exe"
$backupDir   = Join-Path $llamaDir "cpu-build-backup"    # outside build\, so a rebuild can't delete it

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

# Runs a native command and returns everything it printed (stdout + stderr).
# The error preference is relaxed because PowerShell 5.1 turns stderr output
# into an error record, which would otherwise abort the script.
function Invoke-Capture {
    param([string]$Exe, [string[]]$ArgList)
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { $out = & $Exe @ArgList 2>&1 | Out-String }
    finally { $ErrorActionPreference = $old }
    return $out
}

# Runs one setup step. A failure is recorded and the script moves on, so one
# broken step doesn't hide the status of everything after it. An action can
# set $script:StepStatus (e.g. "SKIPPED") and $script:StepDetail.
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

function Save-File {
    param([string]$Url, [string]$Destination)
    # The progress bar makes Invoke-WebRequest dramatically slower in Windows PowerShell
    $previous = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try { Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -Headers @{ "User-Agent" = "setup_gpu.ps1" } }
    finally { $ProgressPreference = $previous }
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

function Get-GpuInfo {
    if (-not (Test-Command "nvidia-smi")) { return $null }

    $query = Invoke-Capture "nvidia-smi" @("--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits")
    $lines = @($query -split "`r?`n" | Where-Object { $_.Trim() -ne "" })
    if ($lines.Count -eq 0) { return $null }

    $parts = @($lines[0] -split "," | ForEach-Object { $_.Trim() })
    if ($parts.Count -lt 3) { return $null }

    $vram = 0
    [void][int]::TryParse($parts[2], [ref]$vram)

    # The highest CUDA version the installed driver supports is in the plain nvidia-smi header
    $header = Invoke-Capture "nvidia-smi" @()
    $cudaVersion = $null
    if ($header -match 'CUDA Version:\s*(\d+\.\d+)') { $cudaVersion = $Matches[1] }

    # compute_cap isn't supported by older drivers — treat anything unexpected as unknown
    $capRaw = (Invoke-Capture "nvidia-smi" @("--query-gpu=compute_cap", "--format=csv,noheader")).Trim()
    $cap = @($capRaw -split "`r?`n")[0].Trim()
    if ($cap -notmatch '^\d+\.\d+$') { $cap = $null }

    return [pscustomobject]@{
        Name        = $parts[0]
        Driver      = $parts[1]
        VramMb      = $vram
        CudaVersion = $cudaVersion
        ComputeCap  = $cap
        GpuCount    = $lines.Count
    }
}

# Asks llama-server which compute devices it can see. Returns $true if it lists CUDA.
function Test-LlamaCuda {
    param([string]$Exe)
    if (-not (Test-Path $Exe)) { return $false }
    $out = Invoke-Capture $Exe @("--list-devices")
    return ($out -match 'CUDA')
}

# Keeps an existing CPU build (e.g. from setup_cpu.ps1) so it's possible to switch back.
# Skipped if the current build is already CUDA, or a backup already exists.
function Backup-CpuBuild {
    if (-not (Test-Path $llamaExe)) { return }
    if (Test-Path $backupDir) { return }
    if (Test-LlamaCuda $llamaExe) { return }
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    Copy-Item -Path (Join-Path $releaseDir "*") -Destination $backupDir -Recurse -Force
    Write-Host "   Saved the existing CPU build to $backupDir"
}

function Get-RunningLlamaServer {
    return @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$llamaDir\*" })
}

# ---------------------------------------------------------------------------
# 1. GPU check
# ---------------------------------------------------------------------------
Write-Section "Checking the GPU"

$gpu = Get-GpuInfo
if (-not $gpu) {
    Write-Host "No NVIDIA GPU or driver detected (nvidia-smi was not found or returned nothing)." -ForegroundColor Red
    Write-Host "Without an NVIDIA GPU, use setup_cpu.ps1 instead." -ForegroundColor Yellow
    Write-Host "If you do have an NVIDIA card, install or update its driver, open a new terminal, and re-run." -ForegroundColor DarkGray
    exit 1
}

Write-Host "  GPU:            $($gpu.Name)" -ForegroundColor Green
Write-Host "  VRAM:           $($gpu.VramMb) MB"
Write-Host "  Driver:         $($gpu.Driver)"
Write-Host "  Max CUDA:       $(if ($gpu.CudaVersion) { $gpu.CudaVersion } else { 'unknown' })"
if ($gpu.ComputeCap) { Write-Host "  Compute cap:    $($gpu.ComputeCap)" }
if ($gpu.GpuCount -gt 1) { Write-Host "  ($($gpu.GpuCount) GPUs found; the first one is shown)" -ForegroundColor DarkGray }

if (-not $gpu.CudaVersion -or ([version]$gpu.CudaVersion) -lt ([version]"12.0")) {
    Write-Host ""
    Write-Host "  The driver reports CUDA $(if ($gpu.CudaVersion) { $gpu.CudaVersion } else { 'unknown' }); the builds used here need CUDA 12 or newer." -ForegroundColor Red
    Write-Host "  Update the NVIDIA driver (nvidia.com/drivers), open a new terminal, and re-run." -ForegroundColor Red
    exit 1
}
if ($gpu.VramMb -gt 0 -and $gpu.VramMb -lt 6000) {
    Write-Host ""
    Write-Host "  Note: under 6 GB of VRAM is tight. Pick small models, and expect the LLM and Whisper not to fit at the same time." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 2. Prerequisites
# ---------------------------------------------------------------------------
Write-Section "Checking prerequisites"

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

# Only needed when building llama.cpp yourself — the default prebuilt path needs none of these
if ($BuildFromSource) {
    Report-Prereq "git"            (Test-Command "git")   "" "winget install Git.Git"
    Report-Prereq "CMake"          (Test-Command "cmake") "" "winget install Kitware.CMake"
    Report-Prereq "C++ compiler"   (Test-CppCompiler)     "Visual Studio Build Tools (C++ workload) not detected" `
        "winget install Microsoft.VisualStudio.2022.BuildTools  (then add the 'Desktop development with C++' workload)"
    Report-Prereq "CUDA Toolkit"   (Test-Command "nvcc")  "nvcc not found" `
        "install from developer.nvidia.com/cuda-downloads (after Visual Studio Build Tools, so it can integrate with it)"
}

# ffmpeg is only needed for uploading audio files to the OpenVINO STT backend
Report-Prereq "ffmpeg" (Test-Command "ffmpeg") "" "winget install Gyan.FFmpeg  (needed for audio-file transcription)" $false

if ($fatalMissing) {
    Write-Host ""
    Write-Host "Required prerequisites are missing. Install them, open a NEW terminal (so PATH refreshes), and re-run." -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# 3. llama.cpp with CUDA
# ---------------------------------------------------------------------------
Write-Section "llama.cpp (CUDA build)"

if ($BuildFromSource) {
    Invoke-Step "Clone llama.cpp" {
        if (Test-Path (Join-Path $llamaDir ".git")) {
            $script:StepStatus = "SKIPPED"; $script:StepDetail = "already cloned"
        }
        elseif ((Test-Path $llamaDir) -and (@(Get-ChildItem $llamaDir -Force).Count -gt 0)) {
            throw "$llamaDir exists but isn't a git clone (maybe from a prebuilt install). Remove or rename it, then re-run."
        }
        else {
            Invoke-Checked "git clone" { & git clone https://github.com/ggml-org/llama.cpp $llamaDir }
        }
    }

    Invoke-Step "Build llama.cpp with CUDA (this takes a while)" {
        if ((Test-LlamaCuda $llamaExe) -and -not $ReinstallLlamaCpp) {
            $script:StepStatus = "SKIPPED"; $script:StepDetail = "CUDA support already detected (use -ReinstallLlamaCpp to rebuild)"
            return
        }
        if ((Get-RunningLlamaServer).Count -gt 0) { throw "llama-server.exe is running and locks its files. Stop the app (Ctrl+C in start.ps1) and re-run." }

        Backup-CpuBuild

        # Stale CMake settings from an earlier (CPU) configure would otherwise be reused
        $buildDir = Join-Path $llamaDir "build"
        if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }

        $cmakeArgs = @("-B", "build", "-DGGML_CUDA=ON")
        if ($gpu.ComputeCap) {
            # e.g. 7.5 -> 75. Building for just this GPU makes the build much faster.
            $cmakeArgs += "-DCMAKE_CUDA_ARCHITECTURES=$($gpu.ComputeCap.Replace('.', ''))"
        }

        Push-Location $llamaDir
        try {
            Invoke-Checked "cmake configure" { & cmake @cmakeArgs }
            Invoke-Checked "cmake build"     { & cmake --build build --config Release -j }
        }
        finally { Pop-Location }

        if (-not (Test-Path $llamaExe)) { throw "Build finished but llama-server.exe was not found at $llamaExe" }
    }
}
else {
    Invoke-Step "Install prebuilt llama.cpp CUDA build" {
        if ((Test-LlamaCuda $llamaExe) -and -not $ReinstallLlamaCpp) {
            $script:StepStatus = "SKIPPED"; $script:StepDetail = "CUDA support already detected (use -ReinstallLlamaCpp to reinstall)"
            return
        }
        if ((Get-RunningLlamaServer).Count -gt 0) { throw "llama-server.exe is running and locks its files. Stop the app (Ctrl+C in start.ps1) and re-run." }

        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Host "   Looking up the latest llama.cpp release..."
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" -Headers @{ "User-Agent" = "setup_gpu.ps1" }

        # Pick the newest CUDA 12.x build that the installed driver can run
        $candidates = @()
        foreach ($asset in $release.assets) {
            if ($asset.name -match '^llama-.*-bin-win-cuda-(12\.\d+)-x64\.zip$') {
                $candidates += [pscustomobject]@{ Version = [version]$Matches[1]; Asset = $asset }
            }
        }
        $usable = @($candidates | Where-Object { $_.Version -le [version]$gpu.CudaVersion } | Sort-Object Version -Descending)
        if ($usable.Count -eq 0) {
            $names = @($release.assets | Where-Object { $_.name -match 'win.*cuda' } | ForEach-Object { $_.name })
            throw "No CUDA 12 Windows build in release $($release.tag_name) matches your driver (CUDA $($gpu.CudaVersion)). Windows CUDA assets found: $($names -join ', '). Try -BuildFromSource, or update the driver."
        }
        $main = $usable[0]
        $verText = $main.Version.ToString()

        # The CUDA runtime DLLs ship as a separate zip with the matching version
        $runtimeName = "cudart-llama-bin-win-cuda-$verText-x64.zip"
        $runtime = $release.assets | Where-Object { $_.name -eq $runtimeName } | Select-Object -First 1
        if (-not $runtime) { throw "Found $($main.Asset.name) but not the matching $runtimeName in release $($release.tag_name)." }

        $tmp = Join-Path $env:TEMP "llama-cuda-setup"
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
        New-Item -ItemType Directory -Force -Path $tmp | Out-Null

        try {
            Write-Host "   Release $($release.tag_name), CUDA $verText"
            Write-Host "   Downloading $($main.Asset.name) ($([math]::Round($main.Asset.size / 1MB)) MB)..."
            $mainZip = Join-Path $tmp $main.Asset.name
            Save-File $main.Asset.browser_download_url $mainZip

            Write-Host "   Downloading $($runtime.name) ($([math]::Round($runtime.size / 1MB)) MB)..."
            $runtimeZip = Join-Path $tmp $runtime.name
            Save-File $runtime.browser_download_url $runtimeZip

            Write-Host "   Extracting..."
            $mainStage    = Join-Path $tmp "main"
            $runtimeStage = Join-Path $tmp "cudart"
            Expand-Archive -Path $mainZip -DestinationPath $mainStage -Force
            Expand-Archive -Path $runtimeZip -DestinationPath $runtimeStage -Force

            # Don't assume the zip layout: find wherever llama-server.exe landed
            $found = Get-ChildItem -Path $mainStage -Recurse -Filter "llama-server.exe" | Select-Object -First 1
            if (-not $found) { throw "llama-server.exe was not found inside $($main.Asset.name)." }

            Backup-CpuBuild

            New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
            Copy-Item -Path (Join-Path $found.DirectoryName "*") -Destination $releaseDir -Recurse -Force
            Copy-Item -Path (Join-Path $runtimeStage "*") -Destination $releaseDir -Recurse -Force
        }
        finally {
            Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        }

        $script:StepDetail = "release $($release.tag_name), CUDA $verText"
    }
}

Invoke-Step "Verify llama.cpp can see the GPU" {
    if (-not (Test-Path $llamaExe)) { throw "llama-server.exe not found at $llamaExe" }
    $out = Invoke-Capture $llamaExe @("--list-devices")
    if ($out -match 'CUDA') {
        $script:StepDetail = "CUDA device listed"
    }
    else {
        # Not fatal: older builds may not support --list-devices at all
        $script:StepStatus = "WARNING"
        $script:StepDetail = "couldn't confirm CUDA. Load a model and look for a 'CUDA' device line in the llama-server startup output."
        Write-Host "   Output was:" -ForegroundColor DarkGray
        foreach ($line in @($out -split "`r?`n" | Where-Object { $_.Trim() -ne "" } | Select-Object -First 8)) { Write-Host "   $line" -ForegroundColor DarkGray }
    }
}

# ---------------------------------------------------------------------------
# 4. Python backends: venv + requirements (+ NVIDIA libraries for faster-whisper)
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

    $venvDir    = Join-Path $dir ".venv"
    $venvPython = Join-Path $venvDir "Scripts\python.exe"

    Invoke-Step "Set up $($b.Name)" {
        $requirements = Join-Path $dir "requirements.txt"
        if (-not (Test-Path $requirements)) { throw "requirements.txt not found in $dir" }

        if (-not (Test-Path $venvPython)) {
            Invoke-Checked "venv creation" { & python -m venv $venvDir }
        }

        # setuptools/wheel first: some packages (e.g. webrtcvad) fail to build without them
        Invoke-Checked "pip upgrade" { & $venvPython -m pip install --upgrade pip setuptools wheel }
        Invoke-Checked "pip install -r requirements.txt" { & $venvPython -m pip install -r $requirements }
    }

    $last = $script:Results[$script:Results.Count - 1]
    if ($last.Status -ne "OK") { continue }
    $readyBackends += $b

    # Only backends that use faster-whisper need the NVIDIA libraries
    $pipShow = Invoke-Capture $venvPython @("-m", "pip", "show", "faster-whisper")
    if ($pipShow -notmatch 'Name:\s*faster-whisper') { continue }

    Invoke-Step "Install NVIDIA libraries for $($b.Name)" {
        # ctranslate2 4.5+ needs cuDNN 9 with CUDA 12; older versions want different libraries
        $ctShow = Invoke-Capture $venvPython @("-m", "pip", "show", "ctranslate2")
        if ($ctShow -match 'Version:\s*(\d+)\.(\d+)') {
            $ctMajor = [int]$Matches[1]; $ctMinor = [int]$Matches[2]
            if ($ctMajor -lt 4 -or ($ctMajor -eq 4 -and $ctMinor -lt 5)) {
                Write-Host "   Warning: ctranslate2 $ctMajor.$ctMinor is older than 4.5, which expects different cuDNN/CUDA versions. Consider: pip install --upgrade ctranslate2 faster-whisper" -ForegroundColor Yellow
            }
        }

        Invoke-Checked "pip install NVIDIA libraries" { & $venvPython -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*" }

        # Confirm the DLLs actually landed in this venv
        $sitePackages = (Invoke-Capture $venvPython @("-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])")).Trim()
        $nvidiaDir = Join-Path $sitePackages "nvidia"
        $cublas = $null
        $cudnn  = $null
        if (Test-Path $nvidiaDir) {
            $cublas = Get-ChildItem -Path $nvidiaDir -Recurse -Filter "cublas64_12.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
            $cudnn  = Get-ChildItem -Path $nvidiaDir -Recurse -Filter "cudnn64_9.dll"  -ErrorAction SilentlyContinue | Select-Object -First 1
        }
        if (-not $cublas -or -not $cudnn) {
            throw "pip finished but cublas64_12.dll / cudnn64_9.dll were not found under $nvidiaDir."
        }

        # ctranslate2 sees the GPU through the driver. This doesn't prove cuBLAS/cuDNN load
        # correctly: that only happens when a model is loaded on the GPU.
        $count = (Invoke-Capture $venvPython @("-c", "import ctranslate2; print(ctranslate2.get_cuda_device_count())")).Trim()
        $lastLine = @($count -split "`r?`n")[-1].Trim()
        if ($lastLine -match '^\d+$' -and [int]$lastLine -ge 1) {
            $script:StepDetail = "libraries installed, ctranslate2 sees $lastLine CUDA device(s)"
        }
        else {
            $script:StepStatus = "WARNING"
            $script:StepDetail = "libraries installed, but ctranslate2 reported no CUDA device"
        }
    }
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
    $llmPython = Join-Path $root "llm-studio-backend\.venv\Scripts\python.exe"

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
# Summary
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
Write-Host "Easiest: run .\start.ps1 to launch everything from one terminal." -ForegroundColor Green
Write-Host ""
Write-Host "Or run each service yourself, one terminal per service:" -ForegroundColor Cyan

foreach ($b in $readyBackends) {
    Write-Host ""
    Write-Host "  # $($b.Name)"
    Write-Host "  cd `"$(Join-Path $root $b.Name)`""
    Write-Host "  .\.venv\Scripts\Activate.ps1"
    Write-Host "  uvicorn main:app --reload --port $($b.Port)"
}

if ($frontendReady) {
    Write-Host ""
    Write-Host "  # frontend"
    Write-Host "  cd `"$frontendDir`""
    Write-Host "  npm run dev"
    Write-Host ""
    Write-Host "  Then open http://localhost:3000"
}

Write-Host ""
Write-Host "What this script can't do for you:" -ForegroundColor Cyan
Write-Host "  - The app has to ask for the GPU. llama-server needs -ngl (layers on GPU) and faster-whisper needs device='cuda'."
Write-Host "  - If loading a Whisper model fails with a missing cublas/cudnn DLL, those folders (site-packages\nvidia\*\bin) must be on PATH for that process."
Write-Host "  - VRAM is shared by every loaded model. Watch it with nvidia-smi if you see out-of-memory errors."
Write-Host "  - Models are not included. Download them from the app's download panels on first use." -ForegroundColor DarkGray
if (Test-Path $backupDir) {
    Write-Host "  - To go back to the CPU build, copy the files from llama.cpp\cpu-build-backup into llama.cpp\build\bin\Release." -ForegroundColor DarkGray
}

$failed = @($script:Results | Where-Object { $_.Status -eq "FAILED" })
if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "$($failed.Count) step(s) failed. Fix the cause and re-run; finished steps are skipped." -ForegroundColor Red
    exit 1
}
exit 0