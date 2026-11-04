$ErrorActionPreference = 'Stop'
$logs = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$voiceReady = $false
try { $voiceHealth=Invoke-RestMethod 'http://127.0.0.1:11440/health' -TimeoutSec 4; $voiceReady=$voiceHealth.service -eq 'echo-voice-gateway' } catch { }
if (-not $voiceReady) {
    if (Get-NetTCPConnection -LocalPort 11440 -State Listen -ErrorAction SilentlyContinue) { throw 'The voice port belongs to an unexpected service.' }
    $voiceTunnel=Start-Process -FilePath 'C:\Windows\System32\OpenSSH\ssh.exe' -ArgumentList @('-N','-L','127.0.0.1:11440:127.0.0.1:8239','-o','ExitOnForwardFailure=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','forge') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'voice-tunnel.stdout.log') -RedirectStandardError (Join-Path $logs 'voice-tunnel.stderr.log')
    @{pid=$voiceTunnel.Id;started=$voiceTunnel.StartTime.ToUniversalTime().ToString('o');kind='ssh-tunnel'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logs 'voice-tunnel-process.json') -Encoding utf8
    for ($attempt=0;$attempt -lt 12;$attempt++) {
        Start-Sleep -Milliseconds 500
        try { $voiceHealth=Invoke-RestMethod 'http://127.0.0.1:11440/health' -TimeoutSec 4; $voiceReady=$voiceHealth.service -eq 'echo-voice-gateway'; if ($voiceReady) { break } } catch { }
        if ($voiceTunnel.HasExited) { break }
    }
    if (-not $voiceReady) { throw 'The configured Voice Gateway is unavailable. Text chat remains usable.' }
}
Write-Output 'Personality Forge voice transport is ready.'
