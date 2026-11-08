#!/usr/bin/env bash
# Builds the NEP-245 resource contract to contracts/near/res/blackout_resources.wasm.
# Preferred: cargo-near (handles NEAR wasm compatibility). Install: https://github.com/near/cargo-near
set -euo pipefail
cd "$(dirname "$0")/../contracts/near"
mkdir -p res
if command -v cargo-near >/dev/null 2>&1; then
  cargo near build non-reproducible-wasm
  cp target/near/blackout_resources.wasm res/blackout_resources.wasm
else
  echo "cargo-near not found; falling back to plain cargo (verify the wasm loads on testnet before relying on it)." >&2
  RUSTFLAGS="-C link-arg=-s" cargo build --target wasm32-unknown-unknown --release
  cp target/wasm32-unknown-unknown/release/blackout_resources.wasm res/blackout_resources.wasm
fi
ls -la res/blackout_resources.wasm
