# Historical folder access diagnostics

The Linux runtime uses GNU coreutils `/usr/bin/test` with separate fixed `-r`,
`-w` and `-x` arguments and an absolute directory argument. No shell is involved.
It inherits the container process identity and supplementary groups. This bypasses
Deno 2.9.5 node:fs.access emulation, which rejects root on a 99:100-owned 775
folder even though effective OS access permits it. The image checks for the GNU
utility at build time. Linux `/proc/self/mountinfo` identifies read-only mounts,
including read-only bind mounts, using the existing bounded mount parser.

Check access only reads metadata and asks the OS about access. It creates no
probe file and changes no permissions or ownership. Successful diagnostics do
not guarantee unlink: ACL/security policy changes, sticky directories, immutable
files, filesystem errors and races can still affect the later operation. Existing
exact-file verification and durable deletion outcomes remain independent.

Structured reason codes share one user-facing formatter for folder cards, manual
results and global warnings. Historical samples and local OS error details stay
under Access details. Remote exceptions are not persisted because they may carry
connection credentials. Existing plain-text reasons remain readable for older
records; a recheck replaces them. A success clears the prior diagnostic/problem.

## Disposable Linux gate

From the repository root on a Linux test machine with root permission:

    bash tools/run_historical_access_gate.sh

The wrapper uses ordinary UID 1000 to obtain pinned Deno 2.9.7, then enters a
private mount namespace. Requires curl, Python, coreutils, util-linux (`unshare`,
`setpriv`, `mount`) and an existing UID 1000 user. All fixture permissions,
ownership and mounts are confined to a generated `/tmp/plex-access-*` directory.
The diagnostic itself remains read-only. The gate tests root with 99:100/775,
non-root denial, supplementary group 100 access, absent samples, missing roots
and read-only bind mounts. It also checks directory metadata remains unchanged.
No live service or production path is used.
