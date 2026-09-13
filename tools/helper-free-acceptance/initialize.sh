#!/bin/sh
set -eu
# Named volumes belong only to the dedicated acceptance Compose project.
# Never replace native service state on a restart.
if [ ! -f /sonarr/config.xml ]; then cp /seed/sonarr.xml /sonarr/config.xml; fi
if [ ! -f /radarr/config.xml ]; then cp /seed/radarr.xml /radarr/config.xml; fi
mkdir -p /qb/qBittorrent
if [ ! -f /qb/qBittorrent/qBittorrent.conf ]; then
  cp /seed/qBittorrent.conf /qb/qBittorrent/qBittorrent.conf
fi
mkdir -p /media/tv /media/movies /media/payloads /media/probe
if [ ! -f /media/probe/source ]; then printf 'disposable hardlink probe\n' > /media/probe/source; fi
if [ ! -f /media/probe/linked ]; then ln /media/probe/source /media/probe/linked; fi
test "$(stat -c %i /media/probe/source)" = "$(stat -c %i /media/probe/linked)"
chown -R 1000:1000 /sonarr /radarr /qb /media
printf 'Fixture volumes initialized; Linux hardlink probe passed. No media acceptance performed.\n'
