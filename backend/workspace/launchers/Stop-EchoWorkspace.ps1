$ErrorActionPreference = 'Stop'
foreach ($receiptName in @('app-process.json','tunnel-process.json','voice-tunnel-process.json')) {
    $receiptPath = Join-Path $PSScriptRoot ('logs\' + $receiptName)
    if (-not (Test-Path -LiteralPath $receiptPath)) { continue }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $process = Get-Process -Id $receipt.pid -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $recordedStart = [DateTimeOffset]$receipt.started
    if ($process.StartTime.ToUniversalTime().Ticks -ne $recordedStart.UtcDateTime.Ticks) { throw 'Process identity changed; refusing to stop a reused process ID.' }
    $expected = if ($receipt.kind -eq 'ssh-tunnel') { 'ssh' } elseif ($receipt.process_name -eq 'pythonw') { 'pythonw' } else { 'python' }
    if ($process.ProcessName -ne $expected) { throw 'Process name does not match the startup receipt.' }
    Stop-Process -Id $process.Id
}
Write-Output 'The workspace processes recorded by this launcher are stopped. Saved chats and journals remain on disk.'
