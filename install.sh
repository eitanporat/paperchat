#!/usr/bin/env bash
# paperchat — one-line installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/eitanporat/paperchat/main/install.sh | bash
# Optional environment variables:
#   PAPERCHAT_DIR=~/paperchat   target install directory
#   PAPERCHAT_REPO=<git url>    fork override
#   PAPERCHAT_BRANCH=main       branch to check out
#   PAPERCHAT_NO_START=1        don't offer to launch the dev server
set -euo pipefail

REPO_URL="${PAPERCHAT_REPO:-https://github.com/eitanporat/paperchat.git}"
INSTALL_DIR="${PAPERCHAT_DIR:-$HOME/paperchat}"
BRANCH="${PAPERCHAT_BRANCH:-main}"

C_OFF=$'\033[0m'; C_DIM=$'\033[2m'; C_OK=$'\033[1;32m'; C_INFO=$'\033[1;36m'; C_WARN=$'\033[1;33m'; C_ERR=$'\033[1;31m'

step() { printf "%s==>%s %s\n" "$C_INFO" "$C_OFF" "$1"; }
ok()   { printf "%s ✓%s %s\n" "$C_OK"   "$C_OFF" "$1"; }
info() { printf "%s i%s %s\n" "$C_INFO" "$C_OFF" "$1"; }
warn() { printf "%s !%s %s\n" "$C_WARN" "$C_OFF" "$1" >&2; }
die()  { printf "%s ✗ error:%s %s\n" "$C_ERR" "$C_OFF" "$1" >&2; exit 1; }

# ---- prerequisite checks -------------------------------------------------
# When run via `curl | bash` the script's stdin is the pipe, so reads from it
# would always return EOF. Bind /dev/tty for interactive prompts.
TTY=""
if [ -e /dev/tty ] && [ -r /dev/tty ] && [ -t 1 ]; then
  TTY=/dev/tty
fi
ask() {
  # ask "Prompt? [Y/n] " "default-answer"
  local prompt="$1" default="${2:-}"
  if [ -z "$TTY" ]; then
    printf "%s [non-interactive: assuming '%s']\n" "$prompt" "$default"
    REPLY="$default"
    return 0
  fi
  printf "%s" "$prompt"
  IFS= read -r REPLY <"$TTY" || REPLY=""
  REPLY="${REPLY:-$default}"
}

ensure_brew_pkg() {
  # ensure_brew_pkg <pkg> "<failed-instructions>"
  local pkg="$1" hint="$2"
  if ! command -v brew >/dev/null 2>&1; then
    die "$pkg is required. $hint"
  fi
  ask "Install $pkg with Homebrew now? [Y/n] " "y"
  case "$REPLY" in
    [Yy]*) step "Running: brew install $pkg" && brew install "$pkg" ;;
    *) die "$pkg is required. $hint" ;;
  esac
}

if ! command -v git >/dev/null 2>&1; then
  ensure_brew_pkg git "Install with: 'brew install git' (macOS) or 'apt install git' (Linux)."
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  warn "Node.js >= 20 not found."
  ensure_brew_pkg node "Install Node.js 20+ from https://nodejs.org/ or via 'nvm install 20'."
  # brew install puts node in PATH for new shells; refresh hash for this one.
  hash -r 2>/dev/null || true
  command -v node >/dev/null 2>&1 || die "node still not on PATH after install. Open a new shell and re-run."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "node $NODE_MAJOR detected; paperchat needs node >= 20."
fi
command -v npm >/dev/null 2>&1 || die "npm not found (it ships with Node.js — your install may be broken)."

# ---- clone or update -----------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  step "Updating existing checkout in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only --quiet origin "$BRANCH"
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR already exists and is not a git repo. Move it aside or set PAPERCHAT_DIR=<other>."
else
  step "Cloning $REPO_URL → $INSTALL_DIR"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# ---- install deps --------------------------------------------------------
step "Installing dependencies (npm install)"
( cd "$INSTALL_DIR" && npm install --silent --no-audit --no-fund )

ok "Installed in $INSTALL_DIR"

# ---- optional OpenRouter setup ------------------------------------------
# Offered only when interactive AND no key is already configured.
ENVF="$INSTALL_DIR/.env.local"
HAS_KEY=0
if [ -f "$ENVF" ] && grep -q '^OPENROUTER_API_KEY=.\+' "$ENVF" 2>/dev/null; then
  HAS_KEY=1
fi

if [ -n "$TTY" ] && [ "$HAS_KEY" -eq 0 ]; then
  echo
  printf "%sOptional:%s OpenRouter key for @claude / @grok / @gpt mentions.\n" "$C_INFO" "$C_OFF"
  printf "  Get one at %shttps://openrouter.ai/keys%s\n" "$C_DIM" "$C_OFF"
  printf "  Skip (Enter) if you only want @code (uses your local Claude Code key on macOS).\n"
  printf "  You can also paste it later via the in-app ⚙ Settings dialog.\n"
  ask "OpenRouter API key: " ""
  if [ -n "$REPLY" ]; then
    touch "$ENVF"
    grep -v '^OPENROUTER_API_KEY=' "$ENVF" > "$ENVF.tmp" 2>/dev/null || true
    printf "OPENROUTER_API_KEY=%s\n" "$REPLY" >> "$ENVF.tmp"
    mv "$ENVF.tmp" "$ENVF"
    chmod 600 "$ENVF"
    ok "Saved OpenRouter key to $ENVF (mode 600)"
  else
    info "Skipped. Set it later via ⚙ Settings or by editing $ENVF."
  fi
fi

# ---- launch dev server (auto, unless explicitly disabled) ----------------
if [ -n "${PAPERCHAT_NO_START:-}" ]; then
  cat <<EOF

${C_DIM}Skipping auto-start (PAPERCHAT_NO_START set). Run when ready:${C_OFF}
  cd $INSTALL_DIR && npm run dev

EOF
  exit 0
fi

cd "$INSTALL_DIR"

# ---- check for an existing process on the port --------------------------
PORT="${PORT:-5173}"
EXISTING_PIDS="$(lsof -ti:"$PORT" 2>/dev/null || true)"
if [ -n "$EXISTING_PIDS" ]; then
  warn "Port $PORT is already in use (PID(s): $(echo "$EXISTING_PIDS" | tr '\n' ' '))"
  ask "Kill the running process(es) and continue? [Y/n] " "y"
  case "${REPLY:-y}" in
    [Yy]*|"")
      echo "$EXISTING_PIDS" | xargs kill 2>/dev/null || true
      sleep 0.4
      LEFTOVER="$(lsof -ti:"$PORT" 2>/dev/null || true)"
      if [ -n "$LEFTOVER" ]; then
        warn "Some process(es) survived SIGTERM; sending SIGKILL"
        echo "$LEFTOVER" | xargs kill -9 2>/dev/null || true
        sleep 0.2
      fi
      ok "Port $PORT freed"
      ;;
    *) die "Port $PORT is occupied. Set PORT=<other> and re-run." ;;
  esac
fi

step "Starting paperchat at http://localhost:$PORT (Ctrl-C to stop)"
printf "%sTip:%s click ⚙ to paste your OpenRouter key (https://openrouter.ai/keys); on macOS @code uses your local 'claude' CLI key automatically.\n\n" "$C_DIM" "$C_OFF"

# Best-effort: open the browser once the server is up.
if command -v open >/dev/null 2>&1; then
  ( sleep 1; open "http://localhost:$PORT" >/dev/null 2>&1 ) &
elif command -v xdg-open >/dev/null 2>&1; then
  ( sleep 1; xdg-open "http://localhost:$PORT" >/dev/null 2>&1 ) &
fi

exec npm run dev
