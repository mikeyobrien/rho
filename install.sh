#!/usr/bin/env bash
# Rho — Universal installer
#
# Two modes, auto-detected:
#
#   User install (curl | bash, or run standalone):
#     curl -fsSL https://rhobot.dev/install | bash
#     Installs rho via npm. No repo clone needed.
#
#   Developer install (run from a git checkout):
#     git clone https://github.com/mikeyobrien/rho.git
#     cd rho && ./install.sh
#     Symlinks rho CLI from local source, installs local deps.
#
# Both paths end with: rho init + rho sync.
#
# Usage: ./install.sh [--force]
#   --force: overwrite existing config files
#
# Idempotent: safe to run multiple times.
set -e

# ── Colors ─────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}>${NC} $1"; }
ok()    { echo -e "${GREEN}ok${NC} $1"; }
warn()  { echo -e "${YELLOW}!!${NC} $1"; }
fail()  { echo -e "${RED}error${NC} $1"; exit 1; }

# ── Parse args ─────────────────────────────────────────────

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
  esac
done

# ── Detect install mode ───────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

detect_mode() {
  # Dev mode: script lives alongside our package.json (git checkout or extracted archive)
  if [ -f "$SCRIPT_DIR/package.json" ]; then
    if grep -q '"@rhobot-dev/rho"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
      MODE="dev"
      REPO_DIR="$SCRIPT_DIR"
      return
    fi
  fi
  MODE="user"
}

# ── Detect platform ───────────────────────────────────────

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
  echo -e "${CYAN}---${NC} $PLATFORM / $MODE install"
  echo ""
}

# ── System dependencies ───────────────────────────────────

install_deps_android() {
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
  pkg install -y -q nodejs-lts tmux 2>/dev/null
  if [ "$MODE" = "dev" ]; then
    pkg install -y -q git 2>/dev/null
  fi
  ok "nodejs $(node --version), tmux"
}

install_deps_macos() {
  local missing=()
  command -v node &>/dev/null  || missing+=("node")
  command -v npm &>/dev/null   || missing+=("npm")
  command -v tmux &>/dev/null  || missing+=("tmux")

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
      echo "  Then: brew install node tmux"
      fail "Missing dependencies"
    fi
  fi
  ok "node $(node --version), tmux"
}

install_deps_linux() {
  local missing=()
  command -v node &>/dev/null  || missing+=("node")
  command -v npm &>/dev/null   || missing+=("npm")
  command -v tmux &>/dev/null  || missing+=("tmux")

  if [ ${#missing[@]} -gt 0 ]; then
    warn "Missing: ${missing[*]}"
    echo ""
    if [ -f /etc/NIXOS ] || command -v nixos-rebuild &>/dev/null; then
      echo "  Add nodejs and tmux to environment.systemPackages, or:"
      echo "  nix-shell -p nodejs tmux"
    elif command -v apt &>/dev/null; then
      echo "  sudo apt update && sudo apt install -y nodejs npm tmux"
    elif command -v pacman &>/dev/null; then
      echo "  sudo pacman -S nodejs npm tmux"
    elif command -v dnf &>/dev/null; then
      echo "  sudo dnf install nodejs npm tmux"
    else
      echo "  Install node (18+), npm, and tmux using your package manager"
    fi
    echo ""
    fail "Install missing dependencies and re-run"
  fi
  ok "node $(node --version), tmux"
}

# ── Install pi ─────────────────────────────────────────────

install_pi() {
  if command -v pi &>/dev/null; then
    ok "pi already installed"
  else
    info "Installing pi coding agent..."
    npm install -g @mariozechner/pi-coding-agent
    ok "pi installed"
  fi
}

# ── Install rho (user mode: npm) ──────────────────────────

install_rho_npm() {
  info "Installing rho via npm..."
  if command -v rho &>/dev/null; then
    local current
    current=$(rho --version 2>/dev/null || echo "unknown")
    ok "rho already installed ($current), upgrading..."
  fi
  npm install -g @rhobot-dev/rho
  ok "rho $(rho --version 2>/dev/null)"
}

# ── Install rho (dev mode: local checkout) ────────────────

install_rho_dev() {
  info "Installing rho from local checkout: $REPO_DIR"

  # Local node deps
  info "Installing Node dependencies..."
  (cd "$REPO_DIR" && npm install)

  # Install extension-level dependencies
  for ext_pkg in "$REPO_DIR"/extensions/*/package.json; do
    [ -f "$ext_pkg" ] || continue
    local ext_dir
    ext_dir="$(dirname "$ext_pkg")"
    info "Installing deps for extension: $(basename "$ext_dir")"
    (cd "$ext_dir" && npm install)
  done

  # Clean up old-style symlinks from previous installs
  local pi_dir="$HOME/.pi/agent"
  if [ -L "$pi_dir/extensions" ]; then
    rm -f "$pi_dir/extensions"
  elif [ -d "$pi_dir/extensions" ]; then
    find "$pi_dir/extensions" -maxdepth 1 -type l -delete 2>/dev/null || true
  fi
  if [ -L "$pi_dir/skills" ]; then
    rm -f "$pi_dir/skills"
  elif [ -d "$pi_dir/skills" ]; then
    find "$pi_dir/skills" -maxdepth 1 -type l -delete 2>/dev/null || true
  fi

  # Symlink rho CLI from this checkout
  local bin_dir
  if [ -n "$PREFIX" ] && [ -d "$PREFIX/bin" ]; then
    bin_dir="$PREFIX/bin"
  else
    bin_dir="$HOME/.local/bin"
    mkdir -p "$bin_dir"
  fi

  # Remove legacy wrapper symlinks
  for name in rho-daemon rho-status rho-stop rho-trigger rho-login; do
    [ -L "$bin_dir/$name" ] && rm -f "$bin_dir/$name"
  done

  chmod +x "$REPO_DIR/cli/index.ts" 2>/dev/null || true
  ln -sf "$REPO_DIR/cli/index.ts" "$bin_dir/rho"
  ok "rho CLI -> $bin_dir/rho (linked to $REPO_DIR/cli/index.ts)"

  # Platform-specific scripts
  if [ "$PLATFORM" = "android" ]; then
    local stt_dir="$REPO_DIR/platforms/android/scripts/bin"
    if [ -d "$stt_dir" ]; then
      mkdir -p "$HOME/bin"
      for script in "$stt_dir"/stt "$stt_dir"/stt-send; do
        [ -f "$script" ] || continue
        chmod +x "$script"
        ln -sf "$script" "$HOME/bin/$(basename "$script")"
      done
      ok "STT scripts -> ~/bin"
    fi
  fi

  # Warn about PATH on non-Termux
  if [ "$PLATFORM" != "android" ]; then
    case ":$PATH:" in
      *":$bin_dir:"*) ;;
      *)
        warn "$bin_dir is not in your PATH. Add to your shell profile:"
        echo "  export PATH=\"$bin_dir:\$PATH\""
        ;;
    esac
  fi
}

# ── Bootstrap config ──────────────────────────────────────

bootstrap_config() {
  echo ""
  info "Initializing config..."

  local init_args="--name rho"
  if [ "$FORCE" -eq 1 ]; then
    init_args="$init_args --force"
  fi

  if [ "$MODE" = "dev" ]; then
    # Run CLI directly from checkout, sync with local source
    node --experimental-strip-types "$REPO_DIR/cli/index.ts" init $init_args
    echo ""
    info "Syncing config (source: $REPO_DIR)..."
    RHO_SOURCE="$REPO_DIR" node --experimental-strip-types "$REPO_DIR/cli/index.ts" sync
  else
    rho init $init_args
    echo ""
    info "Syncing config..."
    rho sync
  fi
}

# ── Platform setup ────────────────────────────────────────

run_platform_setup() {
  if [ "$MODE" = "dev" ]; then
    local setup="$REPO_DIR/platforms/$PLATFORM/setup.sh"
    if [ -f "$setup" ]; then
      echo ""
      chmod +x "$setup"
      bash "$setup"
    fi
  fi
}

# ── Done ───────────────────────────────────────────────────

show_done() {
  echo ""
  echo -e "${GREEN}rho is ready.${NC}"
  echo ""
  echo "  rho                      start and attach"
  echo "  rho start                start in background"
  echo "  rho login                connect your LLM provider"
  echo ""
  echo "  /rho status      check heartbeat (inside session)"
  echo "  /rho now         trigger check-in"
  echo ""

  case "$PLATFORM" in
    android)
      echo "  optional:"
      echo "    install Tasker for UI automation"
      echo "    use /brain to manage memory and reminders"
      ;;
    *)
      echo "  optional:"
      echo "    use /brain to manage memory and reminders"
      ;;
  esac
  echo ""
}

# ── Main ───────────────────────────────────────────────────

detect_mode
detect_platform
show_banner

case "$PLATFORM" in
  android) install_deps_android ;;
  macos)   install_deps_macos ;;
  linux)   install_deps_linux ;;
esac

install_pi

if [ "$MODE" = "dev" ]; then
  install_rho_dev
else
  install_rho_npm
fi

bootstrap_config
run_platform_setup
show_done
