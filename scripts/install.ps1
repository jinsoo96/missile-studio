# missile-studio installer for Windows (PowerShell 5.1+ / 7).
#   irm https://raw.githubusercontent.com/jinsoo96/missile-studio/main/scripts/install.ps1 | iex
# ASCII only (cmd/PowerShell code pages). Uses uv if present, else pipx, else pip --user.
$ErrorActionPreference = "Stop"
$repo = if ($env:MISSILE_REPO) { $env:MISSILE_REPO } else { "https://github.com/jinsoo96/missile-studio" }
$ref = if ($env:MISSILE_REF) { $env:MISSILE_REF } else { "main" }
$spec = "git+$repo.git@$ref"

function Has($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

if (Has "uv") {
  Write-Host "installing with uv tool ..."
  uv tool install --force --python 3.12 "missile-studio @ $spec"
  if ($LASTEXITCODE -ne 0) { uv tool install --force "missile-studio @ $spec" }
} elseif (Has "pipx") {
  Write-Host "installing with pipx ..."
  pipx install --force $spec
} else {
  $py = $null
  foreach ($c in @("py -3.12", "py -3.11", "py -3.10", "python", "python3")) {
    try { $v = & cmd /c "$c -c `"import sys;print(sys.version_info[:2])`" 2>nul"; if ($v) { $py = $c; break } } catch {}
  }
  if (-not $py) {
    Write-Host "no Python found. Install uv first:  irm https://astral.sh/uv/install.ps1 | iex"
    exit 1
  }
  Write-Host "installing with $py -m pip --user ..."
  & cmd /c "$py -m pip install --user --upgrade `"$spec`""
  $bin = & cmd /c "$py -c `"import sysconfig;print(sysconfig.get_path('scripts', 'nt_user'))`""
  if ($env:PATH -notlike "*$bin*") { Write-Host "add to PATH: $bin" }
}

Write-Host ""
Write-Host "done. next:"
Write-Host "  missile provider add --preset openai --api-key sk-...      # or: --preset ollama --model qwen3:8b"
Write-Host "  missile mcp import claude-code                             # pull MCP servers you already use"
Write-Host "  missile serve --open                                       # web UI on http://127.0.0.1:7700"
Write-Host "  missile chat                                               # terminal (works over SSH)"
