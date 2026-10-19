<#
.SYNOPSIS
  Adds NVIDIA GPU (CUDA) support to an existing local-ai setup.

.DESCRIPTION
  Run AFTER setup.ps1, from the repo root. It:
    1. Checks for an NVIDIA GPU and driver.
    2. Replaces llama.cpp's CPU build with a CUDA build (prebuilt download by
       default, or built from source with -BuildFromSource). The CPU build is
       kept in llama.cpp\cpu-build-backup.
    3. Installs the NVIDIA cuBLAS/cuDNN libraries into any STT backend venv
       that uses faster-whisper.

  Only people with an NVIDIA GPU need this. Everyone else can keep using the
  CPU setup from setup.ps1. Safe to re-run.

  If PowerShell blocks the script:
    powershell -ExecutionPolicy Bypass -File .\setup_gpu.ps1

.PARAMETER BuildFromSource
  Build llama.cpp with CUDA yourself instead of downloading a prebuilt one.
  Needs the CUDA Toolkit, CMake and Visual Studio Build Tools.

.PARAMETER Force
  Reinstall the llama.cpp CUDA build even if CUDA support is already detected.

.PARAMETER SkipLlama
  Don't touch llama.cpp.

.PARAMETER SkipWhisper
  Don't touch the faster-whisper backend(s).
#>
[CmdletBinding()]
param(
    [switch]$BuildFromSource,
    [switch]$Force,
    [switch]$SkipLlama,
    [switch]$SkipWhisper
)

$ErrorActionPreference = "Stop"
$root      = $PSScriptRoot
$llamaDir  = Join-Path $root "llama.cpp"
$releaseDir = Join-Path $llamaDir "build\bin\Release"
$llamaExe  = Join-Path $releaseDir "llama-server.exe"
$backupDir = Join-Path $llamaDir "cpu-build-backup"   # outside build\, so a rebuild can't delete it

# STT backends that might use faster-whisper. Each venv is checked, and only
# the ones that actually have faster-whisper installed get changed.
$sttBackends = @("stt-backend", "stt-backend-faster-whisper")

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

# Keeps the CPU build so people can switch back. Skipped if the current build
# is already CUDA (we'd just be backing up the wrong thing) or a backup exists.
function Backup-CpuBuild {
    if (-not (Test-Path $llamaExe)) { return }
    if (Test-Path $backupDir) { return }
    if (Test-LlamaCuda $llamaExe) { return }
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    Copy-Item -Path (Join-Path $releaseDir "*") -Destination $backupDir -Recurse -Force
    Write-Host "   Saved the current CPU build to $backupDir"
}

# ---------------------------------------------------------------------------
# 1. GPU check
# ---------------------------------------------------------------------------
Write-Section "Checking the GPU"

$gpu = Get-GpuInfo
if (-not $gpu) {
    Write-Host "No NVIDIA GPU or driver detected (nvidia-smi was not found or returned nothing)." -ForegroundColor Yellow
    Write-Host "You don't need this script. The CPU setup from setup.ps1 works without a GPU." -ForegroundColor Yellow
    Write-Host "If you do have an NVIDIA card, install or update its driver, open a new terminal, and re-run." -ForegroundColor DarkGray
    exit 0
}

Write-Host "  GPU:            $($gpu.Name)" -ForegroundColor Green
Write-Host "  VRAM:           $($gpu.VramMb) MB"
Write-Host "  Driver:         $($gpu.Driver)"
Write-Host "  Max CUDA:       $(if ($gpu.CudaVersion) { $gpu.CudaVersion } else { 'unknown' })"
if ($gpu.ComputeCap) { Write-Host "  Compute cap:    $($gpu.ComputeCap)" }
if ($gpu.GpuCount -gt 1) { Write-Host "  ($($gpu.GpuCount) GPUs found; the first one is shown)" -ForegroundColor DarkGray }

$fatal = $false
if (-not $gpu.CudaVersion -or ([version]$gpu.CudaVersion) -lt ([version]"12.0")) {
    Write-Host ""
    Write-Host "  The driver reports CUDA $(if ($gpu.CudaVersion) { $gpu.CudaVersion } else { 'unknown' }); the builds used here need CUDA 12 or newer." -ForegroundColor Red
    Write-Host "  Update the NVIDIA driver (nvidia.com/drivers), open a new terminal, and re-run." -ForegroundColor Red
    $fatal = $true
}
if ($gpu.VramMb -gt 0 -and $gpu.VramMb -lt 6000) {
    Write-Host ""
    Write-Host "  Note: under 6 GB of VRAM is tight. Pick small models, and expect the LLM and Whisper not to fit at the same time." -ForegroundColor Yellow
}
if ($fatal) { exit 1 }

# ---------------------------------------------------------------------------
# 2. llama.cpp with CUDA
# ---------------------------------------------------------------------------
Write-Section "llama.cpp (CUDA build)"

if ($SkipLlama) {
    Invoke-Step "llama.cpp CUDA build" { $script:StepStatus = "SKIPPED"; $script:StepDetail = "-SkipLlama" }
}
elseif ($BuildFromSource) {
    Invoke-Step "Build llama.cpp with CUDA (this takes a while)" {
        if (-not (Test-Path $llamaDir)) { throw "llama.cpp folder not found at $llamaDir. Run setup.ps1 first." }
        if (-not (Test-Command "nvcc"))  { throw "CUDA Toolkit not found (nvcc). Install it from developer.nvidia.com/cuda-downloads. Install Visual Studio Build Tools first, so the toolkit can integrate with it." }
        if (-not (Test-Command "cmake")) { throw "CMake not found. Run: winget install Kitware.CMake" }
        if (-not (Test-CppCompiler))     { throw "Visual Studio Build Tools (C++ workload) not found." }

        $running = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$llamaDir\*" })
        if ($running.Count -gt 0) { throw "llama-server.exe is running and locks its files. Stop the app (Ctrl+C in start.ps1) and re-run." }

        Backup-CpuBuild

        # Stale CMake settings from the CPU build would otherwise be reused
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
        if (-not (Test-Path $llamaDir)) { throw "llama.cpp folder not found at $llamaDir. Run setup.ps1 first." }

        if ((Test-LlamaCuda $llamaExe) -and -not $Force) {
            $script:StepStatus = "SKIPPED"; $script:StepDetail = "CUDA support already detected (use -Force to reinstall)"
            return
        }

        $running = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "$llamaDir\*" })
        if ($running.Count -gt 0) { throw "llama-server.exe is running and locks its files. Stop the app (Ctrl+C in start.ps1) and re-run." }

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

if (-not $SkipLlama) {
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
}

# ---------------------------------------------------------------------------
# 3. faster-whisper GPU libraries
# ---------------------------------------------------------------------------
Write-Section "faster-whisper (CUDA libraries)"

if ($SkipWhisper) {
    Invoke-Step "faster-whisper CUDA libraries" { $script:StepStatus = "SKIPPED"; $script:StepDetail = "-SkipWhisper" }
}
else {
    $handled = 0
    foreach ($name in $sttBackends) {
        $dir = Join-Path $root $name
        $py  = Join-Path $dir "venv\Scripts\python.exe"
        if (-not (Test-Path $py)) { continue }   # folder or venv doesn't exist

        $pipShow = Invoke-Capture $py @("-m", "pip", "show", "faster-whisper")
        if ($pipShow -notmatch 'Name:\s*faster-whisper') { continue }   # this backend uses something else

        $handled++
        Invoke-Step "Install NVIDIA libraries for $name" {
            # ctranslate2 4.5+ needs cuDNN 9 with CUDA 12; older versions want different libraries
            $ctShow = Invoke-Capture $py @("-m", "pip", "show", "ctranslate2")
            if ($ctShow -match 'Version:\s*(\d+)\.(\d+)') {
                $ctMajor = [int]$Matches[1]; $ctMinor = [int]$Matches[2]
                if ($ctMajor -lt 4 -or ($ctMajor -eq 4 -and $ctMinor -lt 5)) {
                    Write-Host "   Warning: ctranslate2 $ctMajor.$ctMinor is older than 4.5, which expects different cuDNN/CUDA versions. Consider: pip install --upgrade ctranslate2 faster-whisper" -ForegroundColor Yellow
                }
            }

            Invoke-Checked "pip install NVIDIA libraries" { & $py -m pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*" }

            # Confirm the DLLs actually landed in this venv
            $sitePackages = (Invoke-Capture $py @("-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])")).Trim()
            $nvidiaDir = Join-Path $sitePackages "nvidia"
            $cublas = if (Test-Path $nvidiaDir) { Get-ChildItem -Path $nvidiaDir -Recurse -Filter "cublas64_12.dll" -ErrorAction SilentlyContinue | Select-Object -First 1 }
            $cudnn  = if (Test-Path $nvidiaDir) { Get-ChildItem -Path $nvidiaDir -Recurse -Filter "cudnn64_9.dll"  -ErrorAction SilentlyContinue | Select-Object -First 1 }
            if (-not $cublas -or -not $cudnn) {
                throw "pip finished but cublas64_12.dll / cudnn64_9.dll were not found under $nvidiaDir."
            }

            # ctranslate2 sees the GPU through the driver. This doesn't prove cuBLAS/cuDNN load
            # correctly: that only happens when a model is loaded on the GPU.
            $count = (Invoke-Capture $py @("-c", "import ctranslate2; print(ctranslate2.get_cuda_device_count())")).Trim()
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

    if ($handled -eq 0) {
        Invoke-Step "faster-whisper CUDA libraries" {
            $script:StepStatus = "SKIPPED"
            $script:StepDetail = "no STT backend venv with faster-whisper found"
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
Write-Host "What this script can't do for you:" -ForegroundColor Cyan
Write-Host "  - The app has to ask for the GPU. llama-server needs -ngl (layers on GPU) and faster-whisper needs device='cuda'."
Write-Host "  - If loading a Whisper model fails with a missing cublas/cudnn DLL, those folders (site-packages\nvidia\*\bin) must be on PATH for that process."
Write-Host "  - VRAM is shared by every loaded model. Watch it with nvidia-smi if you see out-of-memory errors."
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