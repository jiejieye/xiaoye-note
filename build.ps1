param([string]$OutputName = '小叶便签-完整版.exe')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskCargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (!(Get-Command cargo -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath (Join-Path $taskCargoBin 'cargo.exe'))) {
    $env:PATH = $taskCargoBin + ';' + $env:PATH
}
if (!(Get-Command cargo -ErrorAction SilentlyContinue)) { throw '请先安装 Rust（rustup，MSVC 目标）。' }



if (!$env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $PSScriptRoot 'target' }
& cargo build --locked --release --manifest-path native/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw '编译失败' }
Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release\小叶便签-轻量隔离版.exe') -Destination (Join-Path $PSScriptRoot $OutputName)
