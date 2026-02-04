#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="$HOME/.pi/agent"
BRAIN_DIR="$HOME/.pi/brain"

echo "Installing rho configuration..."

# Create directories
mkdir -p "$PI_DIR" "$BRAIN_DIR"

# Symlink extensions and skills
rm -rf "$PI_DIR/extensions" "$PI_DIR/skills"
ln -sf "$REPO_DIR/extensions" "$PI_DIR/extensions"
ln -sf "$REPO_DIR/skills" "$PI_DIR/skills"

echo "✓ Symlinked extensions -> $PI_DIR/extensions"
echo "✓ Symlinked skills -> $PI_DIR/skills"

# Bootstrap AGENTS.md with runtime environment
if [ ! -f "$HOME/AGENTS.md" ] || [ "$1" = "--force" ]; then
  # Detect OS
  if [ -n "$TERMUX_VERSION" ]; then
    OS="Android / Termux $TERMUX_VERSION"
  elif [ -f /etc/os-release ]; then
    OS=$(grep ^PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '"')
  else
    OS=$(uname -s)
  fi

  ARCH=$(uname -m)
  USER_SHELL=$(basename "$SHELL")

  sed -e "s|{{OS}}|$OS|g" \
      -e "s|{{ARCH}}|$ARCH|g" \
      -e "s|{{SHELL}}|$USER_SHELL|g" \
      -e "s|{{HOME}}|$HOME|g" \
      -e "s|{{CONFIG_PATH}}|$PI_DIR|g" \
      -e "s|{{BRAIN_PATH}}|$BRAIN_DIR|g" \
      -e "s|{{SKILLS_PATH}}|$PI_DIR/skills|g" \
      "$REPO_DIR/AGENTS.md.template" > "$HOME/AGENTS.md"

  echo "  Note: {{NAME}} and {{DESCRIPTION}} left for agent to fill on first check-in"

  echo "✓ Created ~/AGENTS.md with environment info"
else
  echo "• ~/AGENTS.md exists (use --force to overwrite)"
fi

# Bootstrap brain defaults if empty
if [ -d "$REPO_DIR/brain" ]; then
  for f in "$REPO_DIR/brain"/*.jsonl.default; do
    [ -f "$f" ] || continue
    target="$BRAIN_DIR/$(basename "${f%.default}")"
    if [ ! -f "$target" ]; then
      cp "$f" "$target"
      echo "✓ Created $(basename "$target")"
    fi
  done
fi

# Install rho-daemon scripts to PATH
if [ -d "$REPO_DIR/scripts" ]; then
  # Use $PREFIX/bin for Termux, fallback to ~/.local/bin
  if [ -n "$PREFIX" ] && [ -d "$PREFIX/bin" ]; then
    BIN_DIR="$PREFIX/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
  fi
  
  for script in "$REPO_DIR/scripts"/rho "$REPO_DIR/scripts"/rho-*; do
    [ -f "$script" ] || continue
    chmod +x "$script"
    ln -sf "$script" "$BIN_DIR/$(basename "$script")"
    echo "✓ Installed $(basename "$script") -> $BIN_DIR"
  done
fi

# Bootstrap RHO.md if doesn't exist
if [ ! -f "$HOME/RHO.md" ]; then
  cp "$REPO_DIR/RHO.md.template" "$HOME/RHO.md"
  echo "✓ Created ~/RHO.md (customize your check-in checklist)"
fi

# Bootstrap HEARTBEAT.md if doesn't exist
if [ ! -f "$HOME/HEARTBEAT.md" ]; then
  cp "$REPO_DIR/HEARTBEAT.md.template" "$HOME/HEARTBEAT.md"
  echo "✓ Created ~/HEARTBEAT.md (scheduled tasks for check-ins)"
fi

# Check for API keys
if [ -z "$BRAVE_API_KEY" ]; then
  echo ""
  echo "⚠ BRAVE_API_KEY not set. Add to ~/.bashrc:"
  echo '  export BRAVE_API_KEY="your-key"'
fi

# Check for tmux
if ! command -v tmux &> /dev/null; then
  echo ""
  echo "⚠ tmux not found. Install for background daemon:"
  echo '  pkg install tmux'
fi

echo ""
echo "Done! Run /reload in pi to load extensions."
echo ""
echo "To start rho daemon:"
echo '  rho-daemon      # Background with periodic check-ins'
echo '  rho-stop        # Stop daemon'
echo '  rho-trigger     # Manual check-in'
