# Discovery helper retired

Plex Librarian now collects scoped evidence from Plex, Sonarr/Radarr and
qBittorrent and asks those services to perform authorized deletion. New installs
need only the Librarian container and its persistent app-data volume. There is no
helper pairing, Docker socket, host namespace or media-path setup.

Use [the single-container release Compose file](../compose.yaml) or the repository's
[Unraid template](../../plex-librarian.xml). Service credentials and Arr library
assignments remain in **Settings → Media connections**.

If you installed an older discovery helper, follow [UPGRADING.md](UPGRADING.md).
Updating Librarian does not stop or uninstall a separate container. Old transport
volumes and keys are not deleted automatically. Historical investigation documents
and local demo tools do not describe the current supported installation flow.
