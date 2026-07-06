$node = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (-not (Test-Path $node)) {
  Write-Error "Node.js nao encontrado em $node. Instale Node.js 20+ ou ajuste este script."
  exit 1
}

& $node .\src\server.js
