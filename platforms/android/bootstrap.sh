#!/data/data/com.termux/files/usr/bin/bash
# Rho Bootstrap - One script to go from fresh Termux to running Rho
# Usage: curl -fsSL https://raw.githubusercontent.com/mikeyobrien/rho/main/bootstrap.sh | bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}   rho — AI agent on your phone   ${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════╝${NC}"
echo ""

# ── Preflight ──────────────────────────────────────────────

if [ -z "$TERMUX_VERSION" ]; then
  fail "This script must run inside Termux"
fi

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

# ── System packages ────────────────────────────────────────

info "Installing system packages..."
pkg update -y -q 2>/dev/null
pkg install -y -q nodejs-lts tmux git 2>/dev/null
ok "nodejs $(node --version), tmux, git"

# ── Pi coding agent ────────────────────────────────────────

if command -v pi &>/dev/null; then
  ok "pi already installed ($(pi --version 2>/dev/null || echo 'unknown'))"
else
  info "Installing pi coding agent..."
  npm install -g @mariozechner/pi-coding-agent 2>/dev/null
  ok "pi installed"
fi

# ── Clone rho ──────────────────────────────────────────────

RHO_DIR="$HOME/projects/rho"
if [ -d "$RHO_DIR/.git" ]; then
  ok "rho repo exists at $RHO_DIR"
  info "Pulling latest..."
  cd "$RHO_DIR" && git pull --ff-only 2>/dev/null || true
else
  info "Cloning rho..."
  mkdir -p "$HOME/projects"
  git clone https://github.com/mikeyobrien/rho.git "$RHO_DIR"
  ok "Cloned to $RHO_DIR"
fi

# ── Run install.sh ─────────────────────────────────────────

info "Running rho install..."
cd "$RHO_DIR"
bash install.sh
echo ""

# ── Done ───────────────────────────────────────────────────

echo ""
echo -e "${GREEN}╔══════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}       Rho is ready to go!        ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════╝${NC}"
echo ""
echo "  Start rho:"
echo -e "    ${CYAN}rho${NC}              # Launch and attach"
echo -e "    ${CYAN}rho -d${NC}           # Background daemon"
echo ""
echo "  Inside pi:"
echo -e "    ${CYAN}/rho status${NC}      # Check heartbeat"
echo -e "    ${CYAN}/rho now${NC}         # Trigger check-in"
echo ""
echo "  Optional next steps:"
echo "    • Install Tasker for UI automation"
echo "    • Create ~/SOUL.md for personality"
echo "    • Edit ~/RHO.md for custom check-in tasks"
echo ""
