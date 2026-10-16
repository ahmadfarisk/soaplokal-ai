# 1. Define the commands for the Backend terminal (e.g., activate venv, install deps, start server)
$llmBackendScript = @"
Set-Location '$PSScriptRoot\llm-studio-backend'
Write-Host 'Activating virtual environment...' -ForegroundColor Cyan
.\lai012-venv\Scripts\activate
Write-Host 'Starting LLM Uvicorn server...' -ForegroundColor Cyan
uvicorn main:app --reload --port 8000
"@

$sttBackendScript = @"
Set-Location '$PSScriptRoot\stt-backend-faster-whisper'
Write-Host 'Activating virtual environment...' -ForegroundColor Yellow
.\.venv\Scripts\Activate.ps1
Write-Host 'Starting STT Uvicorn server...' -ForegroundColor Yellow
uvicorn main:app --reload --port 8001
"@

# 2. Define the commands for the Frontend terminal (e.g., install packages, run dev)
$frontendScript = @"
Set-Location '$PSScriptRoot\frontend'
Write-Host 'Starting Vite dev server...' -ForegroundColor Magenta
npm run dev
"@

# For installing vv ##########################################################################
# Write-Host 'Installing frontend dependencies...' -ForegroundColor Yellow
# npm install
##############################################################################################


Start-Process powershell -ArgumentList "-NoExit", "-Command", $llmBackendScript

Start-Process powershell -ArgumentList "-NoExit", "-Command", $sttBackendScript

Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendScript

Write-Host "All separate terminals launched successfully!" -ForegroundColor DarkGreen