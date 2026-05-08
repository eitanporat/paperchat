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
warn() { printf "%s !%s %s\n" "$C_WARN" "$C_OFF" "$1" >&2; }
die()  { printf "%s ✗ error:%s %s\n" "$C_ERR" "$C_OFF" "$1" >&2; exit 1; }

# ---- prerequisite checks -------------------------------------------------
need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required. $2"
}
need git  "Install with: 'brew install git' (macOS) or 'apt install git' (Linux)."
need node "Install Node.js >= 20 from https://nodejs.org/ or via 'brew install node' / 'nvm install 20'."
need npm  "Comes with Node.js — make sure your installation is intact."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "node $NODE_MAJOR detected; paperchat needs node >= 20."
fi

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

# ---- next steps ----------------------------------------------------------
cat <<EOF

${C_DIM}Next steps:${C_OFF}
  cd $INSTALL_DIR
  npm run dev
  # then open http://localhost:5173
  #   click ⚙ to paste your OpenRouter key (https://openrouter.ai/keys)
  #   on macOS, @code uses your local 'claude' CLI's key automatically

EOF

# ---- optional: launch dev server ----------------------------------------
if [ -t 0 ] && [ -t 1 ] && [ -z "${PAPERCHAT_NO_START:-}" ]; then
  printf "Start the dev server now? [Y/n] "
  read -r ans || ans=""
  case "${ans:-y}" in
    [Yy]|"")
      cd "$INSTALL_DIR"
      step "Starting paperchat at http://localhost:5173 (Ctrl-C to stop)"
      # Best-effort: open browser when server is ready (macOS only).
      if command -v open >/dev/null 2>&1; then
        ( sleep 1 && open "http://localhost:5173" >/dev/null 2>&1 ) &
      fi
      exec npm run dev
      ;;
    *) ;;
  esac
fi
