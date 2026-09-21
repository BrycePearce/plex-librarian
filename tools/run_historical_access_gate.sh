#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
gate_user=$(id -un 1000)
runtime=$(runuser -u "$gate_user" -- bash tools/prepare_historical_test_runtime.sh)
unshare --mount --propagation private bash tools/historical_access_linux_gate.sh "$runtime"
