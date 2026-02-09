#!/usr/bin/env bash
# Rho — Cross-platform install script
# Detects OS, checks dependencies, symlinks core + platform files,
# writes config, and bootstraps templates.
#
# Usage: ./install.sh [--force]
#   --force: overwrite existing AGENTS.md
#
# Idempotent: safe to run multiple times.
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="$HOME/.pi/agent"
RHO_DIR="$HOME/.rho"
BRAIN_DIR="$RHO_DIR/brain"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
  esac
done

# --- Platform Detection ---

detect_platform() {
  if [ -n "$TERMUX_VERSION" ]; then
    PLATFORM="android"
  else
    case "$(uname -s)" in
      Darwin) PLATFORM="macos" ;;
      Linux)  PLATFORM="linux" ;;
      *)
        echo "Error: Unsupported OS: $(uname -s)"
        exit 1
        ;;
    esac
  fi
  echo "Detected platform: $PLATFORM"
}

# --- Dependency Checks ---

check_dependencies() {
  local missing=0

  for cmd in node npm tmux git; do
    if ! command -v "$cmd" &>/dev/null; then
      missing=1
      case "$PLATFORM" in
        android)
          echo "⚠ $cmd not found. Installing via pkg..."
          pkg install -y "$cmd" 2>/dev/null || {
            echo "Error: Failed to install $cmd via pkg"
            exit 1
          }
          ;;
        macos)
          case "$cmd" in
            node|npm) echo "⚠ $cmd not found. Install with: brew install node" ;;
            tmux)     echo "⚠ $cmd not found. Install with: brew install tmux" ;;
            git)      echo "⚠ $cmd not found. Install with: brew install git (or xcode-select --install)" ;;
          esac
          ;;
        linux)
          local pkg_hint=""
          if command -v apt &>/dev/null; then
            case "$cmd" in
              node|npm) pkg_hint="sudo apt install nodejs npm" ;;
              *)        pkg_hint="sudo apt install $cmd" ;;
            esac
          elif command -v pacman &>/dev/null; then
            case "$cmd" in
              node|npm) pkg_hint="sudo pacman -S nodejs npm" ;;
              *)        pkg_hint="sudo pacman -S $cmd" ;;
            esac
          elif command -v dnf &>/dev/null; then
            case "$cmd" in
              node|npm) pkg_hint="sudo dnf install nodejs npm" ;;
              *)        pkg_hint="sudo dnf install $cmd" ;;
            esac
          else
            pkg_hint="Install $cmd using your package manager"
          fi
          echo "⚠ $cmd not found. Install with: $pkg_hint"
          ;;
      esac
    fi
  done

  # pi is required for rho to run. Install it automatically if missing.
  if ! command -v pi &>/dev/null; then
    echo "Installing pi coding agent..."
    npm install -g @mariozechner/pi-coding-agent
  fi

  # On desktop, exit if anything was missing (we printed instructions above)
  if [ "$missing" -eq 1 ] && [ "$PLATFORM" != "android" ]; then
    echo ""
    echo "Install missing dependencies and re-run ./install.sh"
    exit 1
  fi
}

# --- Node dependencies (for local-path package installs) ---

install_node_deps() {
  echo "Installing Node dependencies..."
  (cd "$REPO_DIR" && npm install)
}

# --- Cleanup ---

cleanup_old() {
  echo "Cleaning up old symlinks..."

  # Extensions: handle both old-style (directory symlink) and new-style (individual file symlinks)
  if [ -L "$PI_DIR/extensions" ]; then
    # Old install: extensions/ is a symlink to repo dir. Remove the symlink only.
    rm -f "$PI_DIR/extensions"
  elif [ -d "$PI_DIR/extensions" ]; then
    # New install: extensions/ is a real dir with individual symlinks. Remove symlinks inside.
    find "$PI_DIR/extensions" -maxdepth 1 -type l -delete 2>/dev/null || true
    rm -f "$PI_DIR/extensions"/*.ts 2>/dev/null || true
  fi

  # Skills: handle both old-style (directory symlink) and new-style (individual dir symlinks)
  if [ -L "$PI_DIR/skills" ]; then
    # Old install: skills/ is a symlink to repo dir. Remove the symlink only.
    rm -f "$PI_DIR/skills"
  elif [ -d "$PI_DIR/skills" ]; then
    # New install: skills/ is a real dir with individual symlinks.
    # Use find to catch broken symlinks too (glob */ skips them).
    # IMPORTANT: use -L check and rm -f (not rm -rf) for symlinks,
    # otherwise rm -rf follows the symlink and deletes actual repo files.
    find "$PI_DIR/skills" -maxdepth 1 -type l -delete 2>/dev/null || true
    for entry in "$PI_DIR/skills"/*/; do
      [ -d "$entry" ] || continue
      rm -rf "$entry"
    done
  fi
}

# --- Install Extensions ---

install_extensions() {
  mkdir -p "$PI_DIR/extensions"

  # IMPORTANT: core Rho extensions are loaded via pi package loading + filtering
  # (settings.json) and MUST NOT be symlinked into ~/.pi/agent/extensions,
  # otherwise module enable/disable in init.toml cannot work.

  # Platform extensions (Termux/Tasker integration, etc) are still installed
  # as local extensions, since pi has no native platform-conditional package
  # resources.
  local plat_ext="$REPO_DIR/platforms/$PLATFORM/extensions"
  if [ -d "$plat_ext" ]; then
    for entry in "$plat_ext"/*; do
      [ -e "$entry" ] || continue
      if [ -f "$entry" ] && [[ "$entry" == *.ts ]]; then
        ln -sf "$entry" "$PI_DIR/extensions/$(basename "$entry")"
      elif [ -d "$entry" ] && { [ -f "$entry/index.ts" ] || [ -f "$entry/index.js" ]; }; then
        ln -sf "$entry" "$PI_DIR/extensions/$(basename "$entry")"
      fi
    done
    echo "✓ Installed $PLATFORM extensions"
  fi
}

# --- Install Skills ---

install_skills() {
  mkdir -p "$PI_DIR/skills"

  # IMPORTANT: core Rho skills are loaded via pi package loading + filtering
  # (settings.json) and MUST NOT be symlinked into ~/.pi/agent/skills,
  # otherwise module enable/disable in init.toml cannot work.

  # Platform skills are still installed locally.
  local plat_skills="$REPO_DIR/platforms/$PLATFORM/skills"
  if [ -d "$plat_skills" ]; then
    for d in "$plat_skills"/*/; do
      [ -d "$d" ] || continue
      [ -f "${d}SKILL.md" ] || continue
      ln -sf "$d" "$PI_DIR/skills/$(basename "$d")"
    done
    echo "✓ Installed $PLATFORM skills"
  fi
}

# --- Install CLI launcher ---

install_cli() {
  # Determine BIN_DIR
  if [ -n "$PREFIX" ] && [ -d "$PREFIX/bin" ]; then
    BIN_DIR="$PREFIX/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
  fi

  # Clean break: remove legacy wrapper symlinks if present.
  for name in rho-daemon rho-status rho-stop rho-trigger rho-login; do
    if [ -L "$BIN_DIR/$name" ]; then
      rm -f "$BIN_DIR/$name" || true
    fi
  done

  # Install `rho` on PATH by symlinking directly to the Node CLI.
  # No ~/.config/rho/config indirection.
  chmod +x "$REPO_DIR/cli/index.ts" 2>/dev/null || true
  ln -sf "$REPO_DIR/cli/index.ts" "$BIN_DIR/rho"
  echo "✓ Installed rho -> $BIN_DIR/rho"

  # Platform-specific scripts
  if [ "$PLATFORM" = "android" ]; then
    local stt_dir="$REPO_DIR/platforms/android/scripts/bin"
    if [ -d "$stt_dir" ]; then
      local stt_bin="$HOME/bin"
      mkdir -p "$stt_bin"
      for script in "$stt_dir"/stt "$stt_dir"/stt-send; do
        [ -f "$script" ] || continue
        chmod +x "$script"
        ln -sf "$script" "$stt_bin/$(basename "$script")"
      done
      echo "✓ Installed STT scripts -> $stt_bin"
    fi
  fi

  # Warn about PATH on non-Termux
  if [ "$PLATFORM" != "android" ]; then
    case ":$PATH:" in
      *":$BIN_DIR:"*) ;;
      *)
        echo ""
        echo "⚠ $BIN_DIR is not in your PATH. Add to your shell profile:"
        echo "  export PATH=\"$BIN_DIR:\$PATH\""
        echo ""
        ;;
    esac
  fi
}

# --- Bootstrap Templates ---

bootstrap_templates() {
  # AGENTS.md — has template variables that need substitution
  if [ ! -f "$HOME/AGENTS.md" ] || [ "$FORCE" -eq 1 ]; then
    if [ -f "$REPO_DIR/AGENTS.md.template" ]; then
      # Detect OS string for template
      local os_string
      if [ "$PLATFORM" = "android" ]; then
        os_string="Android / Termux $TERMUX_VERSION"
      elif [ -f /etc/os-release ]; then
        os_string=$(grep ^PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '"')
      else
        os_string=$(uname -s)
      fi

      sed -e "s|{{OS}}|$os_string|g" \
          -e "s|{{ARCH}}|$(uname -m)|g" \
          -e "s|{{SHELL}}|$(basename "$SHELL")|g" \
          -e "s|{{HOME}}|$HOME|g" \
          -e "s|{{CONFIG_PATH}}|$PI_DIR|g" \
          -e "s|{{BRAIN_PATH}}|$BRAIN_DIR|g" \
          -e "s|{{RHO_DIR}}|$RHO_DIR|g" \
          -e "s|{{SKILLS_PATH}}|$PI_DIR/skills|g" \
          "$REPO_DIR/AGENTS.md.template" > "$HOME/AGENTS.md"

      echo "✓ Created ~/AGENTS.md ({{NAME}} and {{DESCRIPTION}} left for agent)"
    fi
  else
    echo "• ~/AGENTS.md exists (use --force to overwrite)"
  fi

  # Simple template copies — don't overwrite if they exist
  local -A templates=(
    ["RHO.md.template"]="$HOME/RHO.md"
    ["HEARTBEAT.md.template"]="$HOME/HEARTBEAT.md"
    ["SOUL.md.template"]="$HOME/SOUL.md"
  )

  for tmpl in "${!templates[@]}"; do
    local target="${templates[$tmpl]}"
    if [ ! -f "$target" ]; then
      if [ -f "$REPO_DIR/$tmpl" ]; then
        cp "$REPO_DIR/$tmpl" "$target"
        echo "✓ Created $target"
      fi
    else
      echo "• $(basename "$target") exists (skipped)"
    fi
  done
}

# --- Bootstrap Brain ---

bootstrap_brain() {
  mkdir -p "$BRAIN_DIR"
  if [ -d "$REPO_DIR/brain" ]; then
    for f in "$REPO_DIR/brain"/*.jsonl.default; do
      [ -f "$f" ] || continue
      local target="$BRAIN_DIR/$(basename "${f%.default}")"
      if [ ! -f "$target" ]; then
        cp "$f" "$target"
        echo "✓ Created $(basename "$target")"
      fi
    done
  fi
}

# --- Install Rho-scoped tmux config ---

install_tmux_config() {
  # Rho runs tmux on a dedicated socket with its own config file.
  # We install the default config to ~/.rho/tmux.conf (never overwriting).
  # This avoids touching the user's ~/.tmux.conf.

  local src="$REPO_DIR/configs/tmux-rho.conf"
  local dest="$RHO_DIR/tmux.conf"

  if [ ! -f "$src" ]; then
    return
  fi

  mkdir -p "$RHO_DIR"

  if [ ! -f "$dest" ]; then
    cp "$src" "$dest"
    echo "✓ Installed tmux config template -> ~/.rho/tmux.conf"
    echo "  (rho uses the built-in tmux config by default; set settings.heartbeat.tmux_config to use this file)"
  else
    echo "• ~/.rho/tmux.conf exists (skipped)"
  fi
}

# --- Bootstrap Doom-style config ---

bootstrap_rho_config() {
  echo ""
  echo "Bootstrapping config (init.toml -> pi settings.json)..."

  # Create ~/.rho/init.toml if missing.
  node --experimental-strip-types "$REPO_DIR/cli/index.ts" init --name "rho" >/dev/null 2>&1 || true

  # Sync using the local repo path as the package source.
  RHO_SOURCE="$REPO_DIR" node --experimental-strip-types "$REPO_DIR/cli/index.ts" sync
}

# --- Platform Setup ---

run_platform_setup() {
  local setup="$REPO_DIR/platforms/$PLATFORM/setup.sh"
  if [ -f "$setup" ]; then
    echo ""
    chmod +x "$setup"
    bash "$setup"
  fi
}

# --- Main ---

echo "Installing Rho..."
echo ""

detect_platform
check_dependencies
install_node_deps
cleanup_old
install_extensions
install_skills
install_cli
bootstrap_rho_config
bootstrap_templates
bootstrap_brain
install_tmux_config
run_platform_setup

echo ""
echo "Done! Platform: $PLATFORM"
echo ""
echo "Next steps:"
echo "  1. Check health: rho doctor"
echo "  2. Start: rho start --foreground"
echo "  3. Configure modules: edit ~/.rho/init.toml, then run: rho sync"
