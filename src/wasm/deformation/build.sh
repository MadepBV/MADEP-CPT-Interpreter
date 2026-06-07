#!/usr/bin/env bash
# Build the deformation WASM module.
#
# Usage:
#   source /path/to/emsdk/emsdk_env.sh   # makes emcc available
#   bash src/wasm/deformation/build.sh   # invoke from the repo root
#
# Output: static/wasm/deformation/deformation.{js,wasm}.
set -euo pipefail

if ! command -v em++ >/dev/null 2>&1; then
  echo "em++ not found in PATH. Source emsdk_env.sh first." >&2
  echo "  e.g. source \"\$HOME/tools/emsdk/emsdk_env.sh\"" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC_DIR="$ROOT/src/wasm/deformation"
OUT_DIR="$ROOT/static/wasm/deformation"
mkdir -p "$OUT_DIR"

# Single TU: deformation_wasm.cpp pulls in every header.
em++ \
  -std=c++20 \
  -O3 \
  -ffast-math -fno-finite-math-only \
  -msimd128 \
  -DNDEBUG \
  -fno-exceptions \
  -fno-rtti \
  --closure 0 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createDeformationModule \
  -s ENVIRONMENT=web,worker \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s MAXIMUM_MEMORY=2147483648 \
  -s NO_EXIT_RUNTIME=1 \
  -s FILESYSTEM=0 \
  -s STACK_SIZE=4194304 \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPU32","HEAPF64","HEAPF32"]' \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_madepRunDeformationAnalysis","_madepRunMcPlasticMaterialPoint","_madepRunHsMaterialPoint","_madepGetLastErrorMessage","_madepGetLastNewtonStepIterationsJson","_madepGetLastTier2DiagnosticsJson","_madepFreeBuffer"]' \
  -I "$SRC_DIR" \
  "$SRC_DIR/deformation_wasm.cpp" \
  -o "$OUT_DIR/deformation.js"

echo "Built $OUT_DIR/deformation.{js,wasm}"
ls -lh "$OUT_DIR"/*
