# Start Backend as a background job
$llmBackendJob = Start-Job -ScriptBlock {
    Set-Location "$Using:PSScriptRoot\llm-studio-backend"
	.\lai012-venv\Scripts\activate
    uvicorn main:app --reload --port 8000
}

$sttBackendJob = Start-Job -ScriptBlock {
    Set-Location "$Using:PSScriptRoot\stt-backend"
	.\.venv\Scripts\activate
    uvicorn main:app --reload --port 8001
}

# Start Frontend as a background job
$frontendJob = Start-Job -ScriptBlock {
    Set-Location "$Using:PSScriptRoot\frontend"
    npm run dev
}

Write-Host "Servers are running in the background!" -ForegroundColor Green
Write-Host "Press CTRL+C in this window to shut down all servers at once." -ForegroundColor Yellow

try {
    # Keep the main script alive so background jobs keep running and logs stream
    while ($true) {
        # Receive any output from the jobs so you can still see logs
        $outPut = Receive-Job -Job $llmBackendJob, $sttBackendJob, $frontendJob
		
		if ($outPut) {
            foreach ($line in $outPut) {
                # Only show frontend errors or the main local URL startup link
                if ($line -match "error|ERR_|failed|Local:|VITE v") {
                    Write-Host "[Output] $line" -ForegroundColor Red
                }
				if ($line -match "INFO:main:") {
                    Write-Host "[MAIN] $line" -ForegroundColor Cyan
                }
            }
        }
		
        Start-Sleep -Seconds 1
    }
}
finally {
    # THIS BLOCK RUNS AUTOMATICALLY WHEN YOU PRESS CTRL+C
    Write-Host "`nShutting down all servers..." -ForegroundColor Red
    
    # Stop the PowerShell jobs
    Stop-Job $llmBackendJob, $sttBackendJob, $frontendJob
    Remove-Job $llmBackendJob, $sttBackendJob, $frontendJob
    
    # Force-kill any lingering background processes (Node/Uvicorn) just to be safe
    Stop-Process -Name "node", "python", "uvicorn" -Force -ErrorAction SilentlyContinue
    
    Write-Host "All servers terminated cleanly." -ForegroundColor Green
}