#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $(id -u) == 0 ]]; then
  exec runuser -u "$(id -un 1000)" -- bash tools/run_historical_acceptance.sh "$@"
fi
runtime=$(bash tools/prepare_historical_test_runtime.sh)
config=$(mktemp /tmp/historical-acceptance-config-XXXXXXXX.json)
trap 'rm -f -- "$config"' EXIT
python3 - "$config" <<'PY'
import json, pathlib, sys
config=json.loads(pathlib.Path('backend/deno.json').read_text())
config['imports']['@plex-librarian/shared/']=pathlib.Path('shared').resolve().as_uri()+'/'
config['nodeModulesDir']='none'
config.pop('name', None)
config.pop('tasks', None)
pathlib.Path(sys.argv[1]).write_text(json.dumps(config))
PY
if [[ $# == 0 ]]; then set -- backend/src/features/deletionOperations/workflow/historicalDownloadAcceptance_test.ts; fi
"$runtime" test --config "$config" --allow-all "$@"
