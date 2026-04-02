#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check for bun
if ! command -v bun >/dev/null 2>&1; then
  echo "bun is not installed. Installing via Homebrew..."
  if ! command -v brew >/dev/null 2>&1; then
    echo "Error: Homebrew is not installed. Install it from https://brew.sh"
    exit 1
  fi
  brew install oven-sh/bun/bun
fi

echo "Installing dependencies..."
bun install --cwd "$REPO_DIR"

echo "Building opencode..."
bun run --cwd "$REPO_DIR/packages/opencode" build -- --single --skip-install

# Find the compiled binary
arch=$(uname -m)
if [[ "$arch" == "arm64" || "$arch" == "aarch64" ]]; then
  arch="arm64"
else
  arch="x64"
fi
bin="$REPO_DIR/packages/opencode/dist/opencode-darwin-${arch}/bin/opencode"

if [[ ! -f "$bin" ]]; then
  echo "Error: Build did not produce expected binary at $bin"
  exit 1
fi

echo "Installing opencode binary..."
"$REPO_DIR/install" --binary "$bin" --no-modify-path

echo ""
echo "Done! opencode has been installed to ~/.opencode/bin/opencode"
if [[ ":$PATH:" != *":$HOME/.opencode/bin:"* ]]; then
  echo "Make sure ~/.opencode/bin is in your PATH:"
  echo "  export PATH=\$HOME/.opencode/bin:\$PATH"
fi
