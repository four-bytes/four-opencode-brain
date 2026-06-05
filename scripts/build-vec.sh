#!/usr/bin/env bash
# Build portable sqlite-vec for the current platform with conservative flags.
# No -march=native, no AVX/AVX2 — pure x86-64 baseline (SSE2).
# Output: dist/extensions/<os>-<arch>/vec0.so
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/vendor/sqlite-vec"

# Detect platform
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS-$ARCH" in
  linux-x86_64)  PLATFORM_DIR="linux-x64"; SO_NAME="vec0.so";    EXT_SO=".so"  ;;
  linux-aarch64) PLATFORM_DIR="linux-arm64"; SO_NAME="vec0.so";  EXT_SO=".so"  ;;
  darwin-x86_64) PLATFORM_DIR="darwin-x64"; SO_NAME="vec0.dylib"; EXT_SO=".dylib";;
  darwin-arm64)  PLATFORM_DIR="darwin-arm64"; SO_NAME="vec0.dylib"; EXT_SO=".dylib";;
  *) echo "Unsupported platform: $OS-$ARCH" >&2; exit 1 ;;
esac

OUT_DIR="$ROOT/dist/extensions/$PLATFORM_DIR"
mkdir -p "$OUT_DIR"

# Conservative compile flags — portable across all x86-64 CPUs incl. AVX-less VMs
# Explicitly DO NOT set: -march=native, -mavx, -mavx2, -mfma, SQLITE_VEC_ENABLE_AVX
# NOTE: Do NOT define SQLITE_CORE — this is a loadable extension, not a core build.
# The sqlite3ext.h API (sqlite3_api struct) is used instead.
CFLAGS="-O2 -fPIC -march=x86-64 -DNDEBUG -I$ROOT/build/sqlite-amalgamation-3530000"

case "$OS" in
  linux)  LDFLAGS="-shared -lm" ;;
  darwin) LDFLAGS="-dynamiclib -lm" ;;
esac

cd "$SRC"

# Generate sqlite-vec.h from template with version substitution
VERSION="$(cat VERSION)"
VERSION_MAJOR="$(echo "$VERSION" | cut -d. -f1)"
VERSION_MINOR="$(echo "$VERSION" | cut -d. -f2)"
VERSION_PATCH="$(echo "$VERSION" | cut -d. -f3 | cut -d- -f1)"
DATE="$(date -u +'%FT%TZ%z')"
SOURCE="$(git log -n 1 --pretty=format:%H -- VERSION 2>/dev/null || echo 'unknown')"
export VERSION VERSION_MAJOR VERSION_MINOR VERSION_PATCH DATE SOURCE
envsubst < sqlite-vec.h.tmpl > sqlite-vec.h
echo "[build-vec] Generated sqlite-vec.h (v${VERSION})"

echo "[build-vec] Compiling sqlite-vec v${VERSION} with CFLAGS='$CFLAGS'"
cc $CFLAGS -I"$SRC" -o "$OUT_DIR/$SO_NAME" sqlite-vec.c $LDFLAGS

echo "[build-vec] Built: $OUT_DIR/$SO_NAME"
ls -lh "$OUT_DIR/$SO_NAME"

# Quick verification: zero AVX instructions
if command -v objdump >/dev/null 2>&1 && [ "$OS" = "linux" ]; then
  AVX_COUNT=$(objdump -d "$OUT_DIR/$SO_NAME" 2>/dev/null | grep -cE 'vfmadd|vmovaps|vbroadcast|ymm' || true)
  echo "[build-vec] AVX/YMM instruction count: $AVX_COUNT (expected: 0)"
fi
