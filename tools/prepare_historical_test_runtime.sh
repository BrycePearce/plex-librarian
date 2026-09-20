#!/usr/bin/env bash
# Disposable runtime preparation must run as an ordinary user, never root.
set -euo pipefail
if [[ $(id -u) == 0 ]]; then exit 2; fi
runtime_root=$(mktemp -d /tmp/plex-historical-deno-XXXXXXXX)
curl -fsSL --max-time 60 https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip -o "$runtime_root/deno.zip"
python3 -m zipfile -e "$runtime_root/deno.zip" "$runtime_root"
chmod u+x "$runtime_root/deno"
printf '%s\n' "$runtime_root/deno"
