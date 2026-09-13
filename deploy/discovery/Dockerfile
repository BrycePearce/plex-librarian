FROM denoland/deno:2.9.5@sha256:b429777c3dcff34a6488f365a1537db1640b2d48379b60f5e6206be034472463
USER root
RUN apt-get update && apt-get install -y --no-install-recommends docker-cli iproute2 coreutils procps \
    && docker --version && command -v ss && command -v timeout \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /helper
# The collector explicitly uses this empty directory instead of inherited root
# Docker CLI configuration. The packaged root filesystem is mounted read-only.
RUN mkdir -m 0555 /helper/docker-config
COPY backend/src/features/settings/docker-report.sh ./backend/src/features/settings/docker-report.sh
COPY backend/src/features/settings/dockerStorage.ts ./backend/src/features/settings/dockerStorage.ts
COPY backend/src/features/settings/discoveryAddresses.ts ./backend/src/features/settings/discoveryAddresses.ts
COPY backend/src/features/settings/discoveryTransport.ts ./backend/src/features/settings/discoveryTransport.ts
COPY backend/src/features/settings/discoveryHelper.ts ./backend/src/features/settings/discoveryHelper.ts
COPY shared/serviceStorage.ts ./shared/serviceStorage.ts
RUN sed -i 's/\r$//' backend/src/features/settings/docker-report.sh
RUN deno check --no-config backend/src/features/settings/discoveryHelper.ts
ENTRYPOINT ["deno", "run", "--no-config", "--allow-read=/discovery,/proc,/helper", "--allow-write=/discovery", "--allow-env", "--allow-net", "--allow-sys=uid", "--allow-run=/usr/bin/timeout", "backend/src/features/settings/discoveryHelper.ts"]
