#!/usr/bin/env bash
# Build and run Rho E2E tests in a container.
# Supports both Docker and Podman (auto-detects).
#
# Usage:
#   ./tests/e2e/run.sh              # git clone route (default)
#   ./tests/e2e/run.sh --npm        # npm install route
#   ./tests/e2e/run.sh --regressions # regression tests (#7, #8, #9)
#   ./tests/e2e/run.sh --all        # all routes
#   ./tests/e2e/run.sh --no-cache   # rebuild from scratch
set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Auto-detect container runtime
if command -v docker &>/dev/null; then
  RUNTIME="docker"
elif command -v podman &>/dev/null; then
  RUNTIME="podman"
else
  echo "Error: neither docker nor podman found on PATH"
  exit 1
fi

# Parse args
MODE="clone"
BUILD_ARGS=""
for arg in "$@"; do
  case "$arg" in
    --npm)         MODE="npm" ;;
    --regressions) MODE="regressions" ;;
    --all)         MODE="all" ;;
    --no-cache)    BUILD_ARGS="--no-cache" ;;
  esac
done

run_clone() {
  local IMAGE="rho-e2e-clone"
  echo "━━━ E2E: git clone route ━━━"
  echo "Building $IMAGE..."
  $RUNTIME build $BUILD_ARGS -t "$IMAGE" -f "$REPO_DIR/tests/e2e/Dockerfile" "$REPO_DIR"
  echo ""
  echo "Running..."
  $RUNTIME run --rm "$IMAGE"
}

run_npm() {
  local IMAGE="rho-e2e-npm"
  echo "━━━ E2E: npm install route ━━━"

  # Pack the tarball
  echo "Packing tarball..."
  cd "$REPO_DIR"
  npm pack --quiet 2>&1 | tail -1
  echo ""

  echo "Building $IMAGE..."
  $RUNTIME build $BUILD_ARGS -t "$IMAGE" -f "$REPO_DIR/tests/e2e/Dockerfile.npm" "$REPO_DIR"
  echo ""

  # Clean up tarball
  rm -f "$REPO_DIR"/rhobot-dev-rho-*.tgz

  echo "Running..."
  $RUNTIME run --rm "$IMAGE"
}

run_regressions() {
  local IMAGE="rho-e2e-regressions"
  echo "━━━ E2E: regression tests (#7, #8, #9) ━━━"
  echo "Building $IMAGE..."
  $RUNTIME build $BUILD_ARGS -t "$IMAGE" -f "$REPO_DIR/tests/e2e/Dockerfile.regressions" "$REPO_DIR"
  echo ""
  echo "Running..."
  $RUNTIME run --rm "$IMAGE"
}

case "$MODE" in
  clone)       run_clone ;;
  npm)         run_npm ;;
  regressions) run_regressions ;;
  all)
    run_clone
    echo ""
    echo ""
    run_npm
    echo ""
    echo ""
    run_regressions
    ;;
esac
