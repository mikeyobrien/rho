#!/usr/bin/env bash
# Rho Bootstrap -- Universal installer
# Works on Android/Termux, macOS, and Linux.
# Usage: curl -fsSL https://rhobot.dev/install | bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}>${NC} $1"; }
ok()    { echo -e "${GREEN}ok${NC} $1"; }
warn()  { echo -e "${YELLOW}!!${NC} $1"; }
fail()  { echo -e "${RED}error${NC} $1"; exit 1; }

RHO_DIR="${RHO_DIR:-$HOME/projects/rho}"
REPO_URL="https://github.com/mikeyobrien/rho.git"

# ── Detect Platform ───────────────────────────────────────

detect_platform() {
  if [ -n "$TERMUX_VERSION" ]; then
    PLATFORM="android"
  else
    case "$(uname -s)" in
      Darwin) PLATFORM="macos" ;;
      Linux)  PLATFORM="linux" ;;
      *)      fail "Unsupported OS: $(uname -s)" ;;
    esac
  fi
}

# ── Banner ─────────────────────────────────────────────────

show_banner() {
  echo ""
  echo -e "${CYAN}rho${NC} -- persistent ai agent"
  echo -e "${CYAN}---${NC} $PLATFORM"
  echo ""
}

# ── Android/Termux ─────────────────────────────────────────

install_android() {
  # Check for Termux:API
  if ! command -v termux-battery-status &>/dev/null; then
    warn "Termux:API not installed"
    echo "  Install from F-Droid: https://f-droid.org/packages/com.termux.api/"
    echo "  Rho will work without it, but you'll miss notifications, sensors, etc."
    echo ""
    read -p "Continue anyway? [Y/n] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Nn]$ ]] && exit 1
  fi

  info "Installing system packages..."
  pkg update -y -q 2>/dev/null
  pkg install -y -q nodejs-lts tmux git 2>/dev/null
  ok "nodejs $(node --version), tmux, git"
}

# ── macOS ──────────────────────────────────────────────────

install_macos() {
  local missing=()

  command -v node &>/dev/null  || missing+=("node")
  command -v npm &>/dev/null   || missing+=("npm")
  command -v tmux &>/dev/null  || missing+=("tmux")
  command -v git &>/dev/null   || missing+=("git")

  if [ ${#missing[@]} -gt 0 ]; then
    warn "Missing: ${missing[*]}"
    if command -v brew &>/dev/null; then
      info "Installing via Homebrew..."
      for pkg in "${missing[@]}"; do
        case "$pkg" in
          node|npm) brew install node ;;
          *)        brew install "$pkg" ;;
        esac
      done
    else
      echo ""
      echo "  Install Homebrew: https://brew.sh"
      echo "  Then: brew install node tmux git"
      fail "Missing dependencies"
    fi
  fi
  ok "node $(node --version), tmux, git"
}

# ── Linux ──────────────────────────────────────────────────

install_linux() {
  local missing=()

  command -v node &>/dev/null  || missing+=("node")
  command -v npm &>/dev/null   || missing+=("npm")
  command -v tmux &>/dev/null  || missing+=("tmux")
  command -v git &>/dev/null   || missing+=("git")

  if [ ${#missing[@]} -gt 0 ]; then
    warn "Missing: ${missing[*]}"
    echo ""
    if command -v apt &>/dev/null; then
      echo "  sudo apt update && sudo apt install -y nodejs npm tmux git"
    elif command -v pacman &>/dev/null; then
      echo "  sudo pacman -S nodejs npm tmux git"
    elif command -v dnf &>/dev/null; then
      echo "  sudo dnf install nodejs npm tmux git"
    else
      echo "  Install node (18+), npm, tmux, and git using your package manager"
    fi
    echo ""
    fail "Install missing dependencies and re-run"
  fi
  ok "node $(node --version), tmux, git"
}

# ── Pi coding agent ────────────────────────────────────────

install_pi() {
  if command -v pi &>/dev/null; then
    ok "pi already installed"
  else
    info "Installing pi coding agent..."
    npm install -g @mariozechner/pi-coding-agent
    ok "pi installed"
  fi
}

# ── Clone/update repo ─────────────────────────────────────

clone_repo() {
  if [ -d "$RHO_DIR/.git" ]; then
    ok "rho repo exists at $RHO_DIR"
    info "Pulling latest..."
    cd "$RHO_DIR" && git pull --ff-only 2>/dev/null || true
  else
    info "Cloning rho..."
    mkdir -p "$(dirname "$RHO_DIR")"
    git clone "$REPO_URL" "$RHO_DIR"
    ok "Cloned to $RHO_DIR"
  fi
}

# ── Run install.sh ─────────────────────────────────────────

run_install() {
  info "Running rho install..."
  cd "$RHO_DIR"
  bash install.sh
}

# ── Done ───────────────────────────────────────────────────

show_done() {
  echo ""
  echo -e "${GREEN}rho is ready.${NC}"
  echo ""
  echo "  rho              start and attach"
  echo "  rho -d           start in background"
  echo "  rho login        connect your LLM provider"
  echo ""
  echo "  /rho status      check heartbeat (inside session)"
  echo "  /rho now         trigger check-in"
  echo ""

  case "$PLATFORM" in
    android)
      echo "  optional:"
      echo "    install Tasker for UI automation"
      echo "    create ~/SOUL.md for personality"
      echo "    edit ~/RHO.md for custom tasks"
      ;;
    macos|linux)
      echo "  optional:"
      echo "    create ~/SOUL.md for personality"
      echo "    edit ~/RHO.md for custom tasks"
      ;;
  esac
  echo ""
}

# ── Main ───────────────────────────────────────────────────

detect_platform
show_banner

case "$PLATFORM" in
  android) install_android ;;
  macos)   install_macos ;;
  linux)   install_linux ;;
esac

install_pi
clone_repo
run_install
show_done
