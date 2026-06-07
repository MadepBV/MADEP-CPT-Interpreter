#!/usr/bin/env bash
# Build the retaining-wall WASM module.
#
# Usage:
#   source /path/to/emsdk/emsdk_env.sh   # makes em++ available
#   bash src/wasm/retaining/build.sh     # invoke from the repo root
#
# Output: static/wasm/retaining/retaining.{js,wasm}.
set -euo pipefail

if ! command -v em++ >/dev/null 2>&1; then
  echo "em++ not found in PATH. Source emsdk_env.sh first." >&2
  echo "  e.g. source \"\$HOME/tools/emsdk/emsdk_env.sh\"" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC_DIR="$ROOT/src/wasm/retaining"
OUT_DIR="$ROOT/static/wasm/retaining"
mkdir -p "$OUT_DIR"

# Single TU: retaining_wasm.cpp pulls in every header.
em++ \
  -std=c++20 \
  -O3 \
  -ffast-math -fno-finite-math-only \
  -DNDEBUG \
  -fno-exceptions \
  -fno-rtti \
  --closure 0 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createRetainingModule \
  -s ENVIRONMENT=web,worker \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16777216 \
  -s MAXIMUM_MEMORY=536870912 \
  -s NO_EXIT_RUNTIME=1 \
  -s FILESYSTEM=0 \
  -s STACK_SIZE=2097152 \
  -s EXPORTED_RUNTIME_METHODS='["UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPU8"]' \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_madepRunRetainingAnalysis","_madepRetainingLastError","_madepFreeBuffer","_madepRetainingVersion"]' \
  -I "$SRC_DIR" \
  "$SRC_DIR/retaining_wasm.cpp" \
  -o "$OUT_DIR/retaining.js"

echo "Built $OUT_DIR/retaining.{js,wasm}"
ls -lh "$OUT_DIR"/*
