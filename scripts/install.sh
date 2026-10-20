#!/usr/bin/env sh
# missile-studio installer for Linux / macOS / WSL.
#   curl -fsSL https://raw.githubusercontent.com/jinsoo96/missile-studio/main/scripts/install.sh | sh
# Uses uv when present (fast, no system Python needed), otherwise pipx, otherwise pip --user.
set -eu

REPO="${MISSILE_REPO:-https://github.com/jinsoo96/missile-studio}"
REF="${MISSILE_REF:-main}"
SPEC="git+${REPO}.git@${REF}"

say() { printf '%s\n' "$*"; }

if command -v uv >/dev/null 2>&1; then
  say "installing with uv tool ..."
  uv tool install --force --python 3.12 "missile-studio @ ${SPEC}" || uv tool install --force "missile-studio @ ${SPEC}"
elif command -v pipx >/dev/null 2>&1; then
  say "installing with pipx ..."
  pipx install --force "${SPEC}"
else
  PY=""
  for c in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  done
  if [ -z "$PY" ]; then
    say "no python3 found. Install uv first:  curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
  fi
  say "installing with $PY -m pip --user ..."
  "$PY" -m pip install --user --upgrade "${SPEC}"
  BIN="$("$PY" -c 'import sysconfig;print(sysconfig.get_path("scripts", "posix_user"))')"
  case ":$PATH:" in *":$BIN:"*) ;; *) say "add to PATH: $BIN";; esac
fi

say ""
say "done. next:"
say "  missile provider add --preset openai --api-key sk-...      # or: --preset ollama --model qwen3:8b"
say "  missile mcp import claude-code                             # pull MCP servers you already use"
say "  missile serve --open                                       # web UI on http://127.0.0.1:7700"
say "  missile chat                                               # terminal (works over SSH)"
