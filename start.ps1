<#
.SYNOPSIS
  Starts the whole project (LLM backend, STT backend, frontend) from one terminal.

.DESCRIPTION
  Run from the repo root. All service output goes to .\logs\ — this window only
  shows startup status, error lines, and a report if a service crashes.
  Press Ctrl+C to stop everything (closing this window stops it too).

  If PowerShell blocks the script:
    powershell -ExecutionPolicy Bypass -File .\start.ps1

.PARAMETER Dev
  Run the backends with uvicorn --reload. Off by default, because a reload
  restarts the process and silently unloads any model you had loaded.

.PARAMETER Quiet
  Don't echo error lines in this window (they are still written to the logs,
  and a crash is still reported).

.PARAMETER OpenBrowser
  Open the frontend in your default browser once everything is ready.
#>
[CmdletBinding()]
param(
    [switch]$Dev,
    [switch]$Quiet,
    [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
$root   = $PSScriptRoot
$logDir = Join-Path $root "logs"

# ---------------------------------------------------------------------------
# Services — add a line here to launch another one (e.g. a second STT backend)
# ---------------------------------------------------------------------------
$services = @(
    @{ Name = "llm"; Label = "LLM backend"; Kind = "python"; Dir = "llm-studio-backend";         Port = 8000; Url = "http://localhost:8000/docs"; Timeout = 180 },
    @{ Name = "stt"; Label = "STT backend"; Kind = "python"; Dir = "stt-backend-faster-whisper"; Port = 8001; Url = "http://localhost:8001/docs"; Timeout = 180 },
    @{ Name = "web"; Label = "Frontend";    Kind = "npm";    Dir = "frontend";                   Port = 3000; Url = "http://localhost:3000";      Timeout = 240 }
)

# Lines matching this are echoed to the terminal (case-sensitive on purpose,
# so ordinary words like "no errors" don't trigger it).
$script:ErrorPattern = 'ERROR|CRITICAL|Traceback|Exception|\w+Error:'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
$script:running = @()

# Reads whatever was appended to a log file since the last call. The file is
# opened with ReadWrite sharing so the service writing to it isn't blocked.
function Get-NewLines {
    param($Stream)
    if (-not (Test-Path $Stream.Path)) { return @() }
    $fs = $null
    try {
        $fs = [System.IO.File]::Open($Stream.Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        if ($Stream.Pos -gt $fs.Length) { $Stream.Pos = 0 }   # file was truncated
        [void]$fs.Seek($Stream.Pos, [System.IO.SeekOrigin]::Begin)
        $reader = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        $Stream.Pos = $fs.Position
        if ([string]::IsNullOrEmpty($text)) { return @() }
        return @($text -split "`r?`n" | Where-Object { $_ -ne "" })
    }
    catch { return @() }
    finally { if ($fs) { $fs.Dispose() } }
}

function Show-ErrorLines {
    param($Entry)
    foreach ($stream in $Entry.Streams) {
        $new = @(Get-NewLines $stream)
        if ($new.Count -eq 0) { continue }
        $hits = @($new | Where-Object { $_ -cmatch $script:ErrorPattern })
        $shown = 0
        foreach ($line in $hits) {
            if ($shown -ge 5) { break }   # don't flood the window if something loops
            Write-Host "[$($Entry.Service.Name)] $line" -ForegroundColor Red
            $shown++
        }
        if ($hits.Count -gt $shown) {
            Write-Host "[$($Entry.Service.Name)] ... plus $($hits.Count - $shown) more error lines, see the logs folder" -ForegroundColor DarkRed
        }
    }
}

function Show-LogTail {
    param($Entry)
    foreach ($stream in $Entry.Streams) {
        $tail = @(Get-Content -Path $stream.Path -Tail 15 -ErrorAction SilentlyContinue)
        if ($tail.Count -gt 0) {
            Write-Host "  --- last lines of $($stream.Path) ---" -ForegroundColor DarkGray
            foreach ($line in $tail) { Write-Host "  $line" }
        }
    }
}

function Wait-Ready {
    param($Entry)
    $deadline = (Get-Date).AddSeconds($Entry.Service.Timeout)
    while ((Get-Date) -lt $deadline) {
        if ($Entry.Process.HasExited) { return $false }
        try {
            $r = Invoke-WebRequest -Uri $Entry.Service.Url -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -lt 500) { return $true }
        }
        catch { }   # not up yet
        Start-Sleep -Milliseconds 700
    }
    return $false
}

# taskkill /T kills the whole process tree. That matters: the LLM backend
# spawns llama-server.exe, and uvicorn --reload spawns a worker process.
function Stop-All {
    if ($script:running.Count -gt 0) { Write-Host ""; Write-Host "Stopping services..." -ForegroundColor Cyan }
    foreach ($e in $script:running) {
        if (-not $e.Process.HasExited) {
            & taskkill /PID $e.Process.Id /T /F 2>&1 | Out-Null
        }
    }
    # Safety net: make sure no llama-server from this project survives and keeps holding VRAM
    Get-Process -Name "llama-server" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -like (Join-Path $root "llama.cpp\*") } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
$problems = @()
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { $problems += "npm not found on PATH (install Node.js)" }

foreach ($s in $services) {
    $dir = Join-Path $root $s.Dir
    if (-not (Test-Path $dir)) { $problems += "Folder not found: $dir"; continue }
    if ($s.Kind -eq "python" -and -not (Test-Path (Join-Path $dir ".venv\Scripts\python.exe"))) {
        $problems += "$($s.Label): no venv in $($s.Dir). Run setup.ps1 first."
    }
    if ($s.Kind -eq "npm" -and -not (Test-Path (Join-Path $dir "node_modules"))) {
        $problems += "$($s.Label): node_modules missing. Run setup.ps1 (or npm install) first."
    }
    if (Get-NetTCPConnection -LocalPort $s.Port -State Listen -ErrorAction SilentlyContinue) {
        $problems += "Port $($s.Port) ($($s.Label)) is already in use. A previous run may still be going: check Task Manager for python, node or llama-server."
    }
}

if ($problems.Count -gt 0) {
    Write-Host "Can't start:" -ForegroundColor Red
    foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
    exit 1
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Unbuffered Python output so log files update in real time; no colour codes in logs
$env:PYTHONUNBUFFERED = "1"
$env:NO_COLOR = "1"

# ---------------------------------------------------------------------------
# Start everything
# ---------------------------------------------------------------------------
$exitCode = 0
try {
    Write-Host "Starting services (backends can take a minute to import their libraries)..." -ForegroundColor Cyan

    foreach ($s in $services) {
        $dir    = Join-Path $root $s.Dir
        $outLog = Join-Path $logDir "$($s.Name).out.log"
        $errLog = Join-Path $logDir "$($s.Name).err.log"
        Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue

        if ($s.Kind -eq "python") {
            $python   = Join-Path $dir ".venv\Scripts\python.exe"
            $procArgs = @("-m", "uvicorn", "main:app", "--port", "$($s.Port)")
            if ($Dev) { $procArgs += "--reload" }
            $proc = Start-Process -FilePath $python -ArgumentList $procArgs -WorkingDirectory $dir `
                -NoNewWindow -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        }
        else {
            $proc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "npm run dev") -WorkingDirectory $dir `
                -NoNewWindow -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        }
        $null = $proc.Handle   # without this, ExitCode can come back empty in Windows PowerShell

        $script:running += [pscustomobject]@{
            Service = $s
            Process = $proc
            Streams = @(@{ Path = $outLog; Pos = 0L }, @{ Path = $errLog; Pos = 0L })
        }
    }

    $startFailed = $false
    foreach ($e in $script:running) {
        Write-Host ("  {0,-13}" -f $e.Service.Label) -NoNewline
        if (Wait-Ready $e) {
            Write-Host "ready" -ForegroundColor Green
        }
        else {
            Write-Host "FAILED" -ForegroundColor Red
            if ($e.Process.HasExited) {
                Write-Host "  It exited during startup (code $($e.Process.ExitCode))." -ForegroundColor Red
            }
            else {
                Write-Host "  It didn't respond within $($e.Service.Timeout)s." -ForegroundColor Red
            }
            Show-LogTail $e
            $startFailed = $true
            break
        }
    }

    if ($startFailed) {
        $exitCode = 1
    }
    else {
        Write-Host ""
        Write-Host "Everything is running:" -ForegroundColor Green
        Write-Host "  App:      http://localhost:3000"
        Write-Host "  LLM API:  http://localhost:8000/docs"
        Write-Host "  STT API:  http://localhost:8001/docs"
        Write-Host "  Logs:     $logDir"
        Write-Host ""
        Write-Host "Press Ctrl+C to stop everything." -ForegroundColor Yellow
        if ($OpenBrowser) { Start-Process "http://localhost:3000" }

        # Monitor: echo error lines, and stop everything if any service dies
        $crashed = $false
        while (-not $crashed) {
            foreach ($e in $script:running) {
                if ($e.Process.HasExited) {
                    Write-Host ""
                    Write-Host "$($e.Service.Label) stopped unexpectedly (exit code $($e.Process.ExitCode))." -ForegroundColor Red
                    Show-LogTail $e
                    $crashed = $true
                    $exitCode = 1
                    break
                }
                if (-not $Quiet) { Show-ErrorLines $e }
            }
            if (-not $crashed) { Start-Sleep -Seconds 1 }
        }
    }
}
finally {
    Stop-All
}
exit $exitCode