#!/bin/bash
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
CONFIG_DIR="$HOME/.config/rho"
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

  # On desktop, exit if anything was missing (we printed instructions above)
  if [ "$missing" -eq 1 ] && [ "$PLATFORM" != "android" ]; then
    echo ""
    echo "Install missing dependencies and re-run ./install.sh"
    exit 1
  fi
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

  # Core extensions
  # pi discovery supports:
  # - extensions/*.ts (single-file extensions)
  # - extensions/*/index.ts (directory extensions)
  # This repo uses directory extensions, plus a shared lib/ folder.

  # Link shared library directory (must exist for relative imports like ../lib/mod.ts)
  if [ -d "$REPO_DIR/extensions/lib" ]; then
    ln -sf "$REPO_DIR/extensions/lib" "$PI_DIR/extensions/lib"
  fi

  # Link directory-style extensions (extensions/<name>/index.ts)
  for d in "$REPO_DIR/extensions"/*/; do
    [ -d "$d" ] || continue
    local name
    name="$(basename "$d")"
    [ "$name" = "lib" ] && continue
    if [ -f "${d}index.ts" ] || [ -f "${d}index.js" ]; then
      ln -sf "$d" "$PI_DIR/extensions/$name"
    fi
  done

  # Back-compat: link any single-file extensions sitting at extensions/*.ts
  for f in "$REPO_DIR/extensions"/*.ts; do
    [ -f "$f" ] || continue
    ln -sf "$f" "$PI_DIR/extensions/$(basename "$f")"
  done

  echo "✓ Symlinked core extensions"

  # Platform extensions
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
    echo "✓ Symlinked $PLATFORM extensions"
  fi
}

# --- Install Skills ---

install_skills() {
  mkdir -p "$PI_DIR/skills"

  # Core skills (only dirs containing SKILL.md)
  for d in "$REPO_DIR/skills"/*/; do
    [ -d "$d" ] || continue
    [ -f "${d}SKILL.md" ] || continue
    ln -sf "$d" "$PI_DIR/skills/$(basename "$d")"
  done
  echo "✓ Symlinked core skills"

  # Platform skills (only dirs containing SKILL.md)
  local plat_skills="$REPO_DIR/platforms/$PLATFORM/skills"
  if [ -d "$plat_skills" ]; then
    for d in "$plat_skills"/*/; do
      [ -d "$d" ] || continue
      [ -f "${d}SKILL.md" ] || continue
      ln -sf "$d" "$PI_DIR/skills/$(basename "$d")"
    done
    echo "✓ Symlinked $PLATFORM skills"
  fi
}

# --- Install Scripts ---

install_scripts() {
  # Determine BIN_DIR
  if [ -n "$PREFIX" ] && [ -d "$PREFIX/bin" ]; then
    BIN_DIR="$PREFIX/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    mkdir -p "$BIN_DIR"
  fi

  # Core scripts (rho, rho-daemon, rho-status, rho-stop, rho-trigger)
  for script in "$REPO_DIR/scripts"/rho "$REPO_DIR/scripts"/rho-*; do
    [ -f "$script" ] || continue
    chmod +x "$script"
    ln -sf "$script" "$BIN_DIR/$(basename "$script")"
  done
  echo "✓ Installed scripts -> $BIN_DIR"

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

# --- Write Config ---

write_config() {
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_DIR/config" <<EOF
# Rho configuration — generated by install.sh
# Sourced by rho scripts for portability
RHO_DIR="$REPO_DIR"
RHO_PLATFORM="$PLATFORM"
EOF
  echo "✓ Wrote config -> $CONFIG_DIR/config"
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

# --- Install tmux config (Linux/macOS only) ---

install_tmux_config() {
  # Only install on desktop platforms (not Android -- Termux has its own config)
  if [ "$PLATFORM" = "android" ]; then
    return
  fi

  local src="$REPO_DIR/configs/tmux-rho.conf"
  local dest="$HOME/.tmux.conf"

  if [ ! -f "$src" ]; then
    return
  fi

  if [ ! -f "$dest" ]; then
    cp "$src" "$dest"
    echo "✓ Installed tmux config -> ~/.tmux.conf (SSH-friendly, mobile-optimized)"
  else
    echo "• ~/.tmux.conf exists (skipped -- see configs/tmux-rho.conf for Rho defaults)"
  fi
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
cleanup_old
install_extensions
install_skills
install_scripts
write_config
bootstrap_templates
bootstrap_brain
install_tmux_config
run_platform_setup

echo ""
echo "Done! Platform: $PLATFORM"
echo ""
echo "Next steps:"
echo "  1. Run /reload in pi to load extensions"
echo "  2. Start the daemon: rho-daemon"
echo "  3. Customize: ~/SOUL.md, ~/HEARTBEAT.md, ~/RHO.md"
