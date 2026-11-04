param([switch]$Open)
$ErrorActionPreference = 'Stop'
$workspaceRoot = $PSScriptRoot
$logs = Join-Path $workspaceRoot 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$pythonExe = 'C:\Program Files\Python314\python.exe'
$sshExe = 'C:\Windows\System32\OpenSSH\ssh.exe'
try { & (Join-Path $workspaceRoot 'Start-EchoVoiceTunnel.ps1') } catch { Write-Warning $_.Exception.Message }
$modelReady = $false
try {
    $models = Invoke-RestMethod -Uri 'http://127.0.0.1:11439/api/ps' -TimeoutSec 3
    $modelReady = @($models.models).Count -eq 1 -and @($models.models | Where-Object { $_.name -eq 'c3po-code:echo-qwen38-abliterated-256k' -and $_.context_length -eq 262144 }).Count -eq 1
} catch { }
if (-not $modelReady) {
    $listener = Get-NetTCPConnection -LocalPort 11439 -State Listen -ErrorAction SilentlyContinue
    if ($listener) { throw 'Port 11439 belongs to an unexpected endpoint. No process was stopped.' }
    $tunnel = Start-Process -FilePath $sshExe -ArgumentList @('-N','-L','127.0.0.1:11439:127.0.0.1:11441','-o','ExitOnForwardFailure=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','forge') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'tunnel.stdout.log') -RedirectStandardError (Join-Path $logs 'tunnel.stderr.log')
    @{pid=$tunnel.Id;started=$tunnel.StartTime.ToUniversalTime().ToString('o');kind='ssh-tunnel'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logs 'tunnel-process.json') -Encoding utf8
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        Start-Sleep -Milliseconds 500
        try { $models = Invoke-RestMethod -Uri 'http://127.0.0.1:11439/api/ps' -TimeoutSec 2; $modelReady = @($models.models).Count -eq 1 -and @($models.models | Where-Object { $_.name -eq 'c3po-code:echo-qwen38-abliterated-256k' -and $_.context_length -eq 262144 }).Count -eq 1; if ($modelReady) { break } } catch { }
        if ($tunnel.HasExited) { break }
    }
    if (-not $modelReady) { throw 'The private tunnel could not reach the configured loaded FORGE model. See the tunnel log.' }
}
$appReady = $false
try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8768/api/health' -TimeoutSec 5; $appReady = $health.service -eq 'echo-qwen-workspace' } catch { }
if (-not $appReady) {
    if (Get-NetTCPConnection -LocalPort 8768 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 8768 is already occupied. No process was stopped.' }
    $arguments = @('-X','utf8',('"' + (Join-Path $workspaceRoot 'app\app.py') + '"'),'--data',('"' + (Join-Path $workspaceRoot 'data') + '"'),'--config',('"' + (Join-Path $workspaceRoot 'workspace-config.json') + '"'),'--port','8768')
    $server = Start-Process -FilePath $pythonExe -ArgumentList $arguments -WorkingDirectory $workspaceRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'app.stdout.log') -RedirectStandardError (Join-Path $logs 'app.stderr.log')
    @{pid=$server.Id;started=$server.StartTime.ToUniversalTime().ToString('o');kind='workspace'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logs 'app-process.json') -Encoding utf8
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 400
        try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8768/api/health' -TimeoutSec 3; if ($health.service -eq 'echo-qwen-workspace') { $appReady = $true; break } } catch { }
        if ($server.HasExited) { break }
    }
    if (-not $appReady) { throw 'The workspace did not start. See logs\app.stderr.log.' }
}
Write-Output 'Echo Workspace is ready at http://127.0.0.1:8768'
if ($Open) { Start-Process 'http://127.0.0.1:8768' }
