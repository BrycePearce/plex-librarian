#!/usr/bin/env bash
# Run in a private mount namespace as root using system tools only. The supplied
# native Deno runtime is ALWAYS invoked through runuser as an ordinary user.
# Usage: sudo unshare --mount --propagation private bash tools/historical_download_linux_gate.sh /path/to/deno username
set -euo pipefail
deno_native=$(realpath "$1")
test_user=$2
test_uid=$(id -u "$test_user")
test_gid=$(id -g "$test_user")
if [[ "$test_uid" == 0 ]]; then exit 2; fi
test_root=$(mktemp -d /tmp/plex-historical-gate-XXXXXXXX)
case "$test_root" in /tmp/plex-historical-gate-*) ;; *) exit 2 ;; esac
mounted=0
cleanup() {
  if [[ "$mounted" == 1 ]]; then umount "$test_root/alias" || return; fi
  rm -rf -- "$test_root"
}
trap cleanup EXIT
mkdir "$test_root/source" "$test_root/alias" "$test_root/app"
printf '%s' 'disposable bind evidence' > "$test_root/source/episode"
chown -R "$test_uid:$test_gid" "$test_root"
mount --bind "$test_root/source" "$test_root/alias"
mounted=1
runuser -u "$test_user" -- env HISTORICAL_BIND_ROOT="$test_root" "$deno_native" test --no-config --no-check --allow-all backend/src/features/mediaDeletion/historicalDownloadPrototype_test.ts backend/src/features/deletionOperations/workflow/historicalDownloadJournal_test.ts
umount "$test_root/alias"
mounted=0
runuser -u "$test_user" -- env HISTORICAL_UNMOUNTED_ROOT="$test_root" "$deno_native" test --no-config --no-check --allow-all --filter 'unmounted alias' backend/src/features/mediaDeletion/historicalDownloadPrototype_test.ts
