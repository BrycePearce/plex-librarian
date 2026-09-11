#!/bin/sh
# Read-only Docker configuration report. Run on the Docker host, not in Librarian.
# Deliberately excludes environment variables, labels, commands, and volume options.
set -eu
command -v docker >/dev/null 2>&1 || { echo 'Docker CLI is required.' >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo 'Run this collector on a native Linux Docker host.' >&2; exit 1; }
case "$(uname -r)" in *[Mm]icrosoft*|*[Ww][Ss][Ll]*) echo 'WSL and Docker Desktop are unsupported; use a native Linux Docker host.' >&2; exit 1;; esac
if [ -n "${DOCKER_CONTEXT:-}" ]; then endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' "$DOCKER_CONTEXT");
elif [ -n "${DOCKER_HOST:-}" ]; then endpoint=$DOCKER_HOST; else
  context=$(docker context show)
  endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' "$context")
fi
case "$endpoint" in unix:///*) ;; *) echo 'Run this collector against the local Docker Unix socket on its Linux host.' >&2; exit 1;; esac
[ "$(docker info --format '{{.OSType}}')" = linux ] || { echo 'Only Linux Docker hosts are supported.' >&2; exit 1; }
case "$(docker info --format '{{.OperatingSystem}} {{.Name}}')" in *[Dd]esktop*|*linuxkit*) echo 'Docker Desktop is unsupported; use a native Linux Docker host.' >&2; exit 1;; esac
daemon=$(docker info --format '{{json .ID}}')
ids=$(docker ps -q --no-trunc)
if [ -z "$ids" ]; then echo 'No running Docker containers were found.' >&2; exit 1; fi
# Docker IDs are hex; validate before using shell word splitting.
for id in $ids; do case "$id" in *[!0-9a-f]*|'') echo 'Invalid Docker container ID.' >&2; exit 1;; esac; done
# Packaged helper: its ENTRYPOINT is Deno itself. Verify our actual host PID against
# Docker's container init PID and declared namespace modes. Comparing /proc/self
# with /proc/1 alone is insufficient: both can belong to an isolated container.
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = --helper-pid ] || { echo 'Invalid collector invocation.' >&2; exit 1; }
  case "$2" in *[!0-9]*|'') echo 'Invalid helper PID.' >&2; exit 1;; esac
  [ "$2" -gt 1 ] || { echo 'The helper must use the host PID namespace.' >&2; exit 1; }
  matched=0
  for id in $ids; do
    context=$(docker inspect --format '{{.State.Pid}} {{.HostConfig.PidMode}} {{.HostConfig.NetworkMode}}' "$id")
    [ "$context" != "$2 host host" ] || matched=$((matched + 1))
  done
  [ "$matched" -eq 1 ] || { echo 'Helper host PID/network ownership could not be established.' >&2; exit 1; }
fi
addresses=$(hostname -I 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9a-fA-F:.]+$/ && $i != "127.0.0.1" && $i != "::1") {if(n++) printf ","; printf "\"%s\"",$i}}' || true)
printf '{"version":3,"daemonId":%s,"generatedAt":"%s","hostAddresses":[%s],"volumes":[' "$daemon" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$addresses"
volume_names=$(docker inspect --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' $ids | sort -u)
separator=''
for volume in $volume_names; do
  case "$volume" in *[!a-zA-Z0-9_.-]*|'') echo 'Unsupported Docker volume name.' >&2; exit 1;; esac
  value=$(docker volume inspect --format '{"Name":{{json .Name}},"Driver":{{json .Driver}},"OptionsCount":{{len .Options}}}' "$volume")
  printf '%s%s' "$separator" "$value"; separator=,
done
printf '],"containers":['
separator=''
for id in $ids; do
  # All strings below are escaped by Docker's JSON formatter.
  value=$(docker inspect --format '{"Id":{{json .Id}},"Name":{{json .Name}},"State":{"Running":{{json .State.Running}}},"Mounts":{{if .Mounts}}{{json .Mounts}}{{else}}[]{{end}},"NetworkMode":{{json .HostConfig.NetworkMode}},"nonRecursiveBindTargets":[{{$first := true}}{{range (index .HostConfig "Mounts")}}{{$bind := index . "BindOptions"}}{{if $bind}}{{if index $bind "NonRecursive"}}{{if not $first}},{{end}}{{$first = false}}{{json .Target}}{{end}}{{end}}{{end}}],"volumeSubpaths":[{{$first := true}}{{range (index .HostConfig "Mounts")}}{{$volume := index . "VolumeOptions"}}{{if $volume}}{{if index $volume "Subpath"}}{{if not $first}},{{end}}{{$first = false}}{"Destination":{{json .Target}},"Subpath":{{json (index $volume "Subpath")}}}{{end}}{{end}}{{end}}],"tmpfsTargets":[{{$first := true}}{{range $target,$unused := (index .HostConfig "Tmpfs")}}{{if not $first}},{{end}}{{$first = false}}{{json $target}}{{end}}],"Networks":[{{$first := true}}{{range $name,$n := .NetworkSettings.Networks}}{{if not $first}},{{end}}{{$first = false}}{"Name":{{json $name}},"IPAddress":{{json (or (index $n "IPAddress") "")}},"GlobalIPv6Address":{{json (or (index $n "GlobalIPv6Address") "")}},"Aliases":{{if index $n "Aliases"}}{{json (index $n "Aliases")}}{{else}}[]{{end}}}{{end}}],"Ports":[{{$first := true}}{{range $key,$bindings := .NetworkSettings.Ports}}{{if eq (index (split $key "/") 1) "tcp"}}{{range $bindings}}{{if not $first}},{{end}}{{$first = false}}{"containerPort":{{json $key}},"hostIp":{{json .HostIp}},"hostPort":{{json .HostPort}}}{{end}}{{end}}{{end}}],"declaredPorts":[{{$first := true}}{{range $key,$unused := (index .Config "ExposedPorts")}}{{if eq (index (split $key "/") 1) "tcp"}}{{if not $first}},{{end}}{{$first = false}}{{json $key}}{{end}}{{end}}]' "$id")
  listeners=''
  mode=$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$id")
  if [ "$mode" = host ] && command -v ss >/dev/null 2>&1; then
    pids=$(docker top "$id" -eo pid 2>/dev/null | awk 'NR>1 && $1 ~ /^[0-9]+$/ {printf "%s,",$1}' || true)
    if [ -n "$pids" ]; then
      listeners=$(ss -ltnpH 2>/dev/null | awk -v pids=",$pids" '
        { line=$0; owned=0; while(match(line,/pid=[0-9]+/)) {pid=substr(line,RSTART+4,RLENGTH-4); if(index(pids,"," pid ",")) owned=1; line=substr(line,RSTART+RLENGTH)}
          if(owned) {address=$4; sub(/:[0-9]+$/,"",address); port=$4; sub(/^.*:/,"",port); if((address=="*" || address=="0.0.0.0" || address=="[::]" || address=="::") && port ~ /^[0-9]+$/ && port>0 && port<=65535) seen[port]=1}}
        END {for(port in seen) {if(n++) printf ","; printf "%d",port}}' || true)
    fi
  fi
  printf '%s%s,"listeningPorts":[%s]}' "$separator" "$value" "$listeners"; separator=,
done
printf ']}\n'
