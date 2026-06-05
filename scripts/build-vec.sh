#!/usr/bin/env bash
# Download prebuilt sqlite-vec v0.1.9 loadable extension from GitHub Releases.
# Output: dist/extensions/<os>-<arch>/vec0.<ext>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="0.1.9"
BASE_URL="https://github.com/asg017/sqlite-vec/releases/download/v0.1.9"

# Detect platform
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS-$ARCH" in
  linux-x86_64)
    PLATFORM_DIR="linux-x64"
    ASSET="sqlite-vec-${VERSION}-loadable-linux-x86_64.tar.gz"
    SOURCE_FILE="vec0.so"
    TARGET_FILE="vec0.so"
    ;;
  linux-aarch64)
    PLATFORM_DIR="linux-arm64"
    ASSET="sqlite-vec-${VERSION}-loadable-linux-aarch64.tar.gz"
    SOURCE_FILE="vec0.so"
    TARGET_FILE="vec0.so"
    ;;
  darwin-x86_64)
    PLATFORM_DIR="darwin-x64"
    ASSET="sqlite-vec-${VERSION}-loadable-macos-x86_64.tar.gz"
    SOURCE_FILE="vec0.dylib"
    TARGET_FILE="vec0.dylib"
    ;;
  darwin-arm64)
    PLATFORM_DIR="darwin-arm64"
    ASSET="sqlite-vec-${VERSION}-loadable-macos-aarch64.tar.gz"
    SOURCE_FILE="vec0.dylib"
    TARGET_FILE="vec0.dylib"
    ;;
  *)
    echo "Unsupported platform: $OS-$ARCH" >&2
    exit 1
    ;;
esac

OUT_DIR="$ROOT/dist/extensions/$PLATFORM_DIR"
CACHE_DIR="$ROOT/.cache"
CACHE_FILE="$CACHE_DIR/$ASSET"

mkdir -p "$OUT_DIR" "$CACHE_DIR"

# Download if not cached
if [ ! -f "$CACHE_FILE" ]; then
  echo "[build-vec] Downloading $ASSET ..."
  curl -sSL --retry 3 --retry-delay 2 \
    "${BASE_URL}/${ASSET}" \
    -o "$CACHE_FILE"
  echo "[build-vec] Cached to $CACHE_FILE"
fi

# Extract to temp dir
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "[build-vec] Extracting $SOURCE_FILE ..."
tar -xzf "$CACHE_FILE" -C "$TEMP_DIR"

if [ ! -f "$TEMP_DIR/$SOURCE_FILE" ]; then
  echo "[build-vec] ERROR: $SOURCE_FILE not found in archive" >&2
  echo "[build-vec] Archive contents:" >&2
  tar -tzf "$CACHE_FILE" >&2
  exit 1
fi

# Copy to output
cp "$TEMP_DIR/$SOURCE_FILE" "$OUT_DIR/$TARGET_FILE"
echo "[build-vec] Installed: $OUT_DIR/$TARGET_FILE"
ls -lh "$OUT_DIR/$TARGET_FILE"
