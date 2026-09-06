$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$appExecutable = Join-Path $projectRoot 'release\win-unpacked\AelionBot.exe'
$dataRoot = Join-Path $projectRoot '.local\app'
$modelExecutable = Join-Path $projectRoot 'runtime\local-model\server\llama-server.exe'
$modelWeights = Join-Path $projectRoot 'runtime\local-model\Qwen3-1.7B-Q8_0.gguf'
if (-not (Test-Path -LiteralPath $appExecutable)) { throw '请先运行 npm run package:win 生成 Windows 客户端。' }
$statePath = Join-Path $dataRoot 'state.json'
if (Test-Path -LiteralPath $statePath) {
  $savedState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($savedState.model.baseUrl -eq 'http://127.0.0.1:38931/v1' -and $savedState.model.model -eq 'aelion-local') {
    $listening = $false
    $probe = [Net.Sockets.TcpClient]::new()
    try { $pending = $probe.ConnectAsync('127.0.0.1',38931); if ($pending.Wait(700) -and $probe.Connected) { $listening=$true } } catch {} finally { $probe.Dispose() }
    if (-not $listening) {
      if (-not (Test-Path -LiteralPath $modelExecutable) -or -not (Test-Path -LiteralPath $modelWeights)) { throw '本地测试模型缺失。请运行模型准备脚本，或在客户端配置其他 API。' }
      $logDir = Join-Path $projectRoot '.local\proof'
      New-Item -ItemType Directory -Path $logDir -Force | Out-Null
      $modelArguments = @('--model', ('"{0}"' -f $modelWeights), '--alias', 'aelion-local', '--ctx-size', '16384', '--threads', '6', '--parallel', '1', '--jinja', '--chat-template-kwargs', '"{\"enable_thinking\":false}"', '--reasoning-budget', '0', '--host', '127.0.0.1', '--port', '38931')
      Start-Process -FilePath $modelExecutable -ArgumentList $modelArguments -WorkingDirectory (Split-Path -Parent $modelExecutable) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'launcher-model.stdout.log') -RedirectStandardError (Join-Path $logDir 'launcher-model.stderr.log') | Out-Null
    }
  }
}
$env:AELION_DATA_DIR = $dataRoot
Start-Process -FilePath $appExecutable -WorkingDirectory $projectRoot -WindowStyle Normal | Out-Null
