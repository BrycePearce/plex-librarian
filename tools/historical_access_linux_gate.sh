#!/usr/bin/env bash
# Private disposable mount namespace only. Requires root, setpriv and pinned Deno 2.9.5.
set -euo pipefail
runtime=$(realpath "$1")
[[ $(id -u) == 0 && $("$runtime" --version | head -n1) == 'deno 2.9.5 '* ]]
fixture=$(mktemp -d /tmp/plex-access-XXXXXXXX)
case "$fixture" in /tmp/plex-access-*) ;; *) exit 2;; esac
mounted=0
cleanup() {
  if [[ $mounted == 1 ]]; then umount "$fixture/readonly" || return; fi
  rm -rf -- "$fixture"
}
trap cleanup EXIT
chmod 755 "$fixture"
install -m 755 "$runtime" "$fixture/deno"
runtime="$fixture/deno"
mkdir "$fixture/cache"
chmod 777 "$fixture/cache"
export DENO_DIR="$fixture/cache"
mkdir "$fixture"/{root,denied,group,readonly,absent}
touch "$fixture"/{root,denied,group,readonly}/sample
chown 99:100 "$fixture/root" "$fixture/group"
chmod 775 "$fixture/root"
chmod 770 "$fixture/group"
chmod 700 "$fixture/denied"
export HISTORICAL_ACCESS_FIXTURE="$fixture"
script=backend/src/features/arr/historicalAccessInspection_linux_test.ts
for scenario in root absent; do
  HISTORICAL_ACCESS_CASE=$scenario "$runtime" test --no-config --no-check --allow-all "$script"
done
HISTORICAL_ACCESS_CASE=denied setpriv --reuid=65534 --regid=65534 --clear-groups "$runtime" test --no-config --no-check --allow-all "$script"
HISTORICAL_ACCESS_CASE=group setpriv --reuid=65534 --regid=65534 --groups=100 "$runtime" test --no-config --no-check --allow-all "$script"
mount --bind "$fixture/readonly" "$fixture/readonly"
mounted=1
mount -o remount,bind,ro "$fixture/readonly"
HISTORICAL_ACCESS_CASE=readonly "$runtime" test --no-config --no-check --allow-all "$script"
