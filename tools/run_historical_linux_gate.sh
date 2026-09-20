#!/usr/bin/env bash
# WSL gate entrypoint: only packaged system tools run as root.
set -euo pipefail
cd "$(dirname "$0")/.."
gate_user=$(id -un 1000)
gate_deno=$(runuser -u "$gate_user" -- bash tools/prepare_historical_test_runtime.sh)
unshare --mount --propagation private bash tools/historical_download_linux_gate.sh "$gate_deno" "$gate_user"
