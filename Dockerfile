# ── Stage 1: build frontend ───────────────────────────────────────────────────
FROM denoland/deno:2.9.7 AS builder

WORKDIR /app

# Copy workspace manifests first so dep downloads are cached separately from source
COPY deno.json deno.lock ./
COPY shared/ ./shared/
COPY frontend/ ./frontend/

RUN deno install && deno task build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM denoland/deno:2.9.7

USER root

# Read-only folder diagnostics use GNU coreutils test, not Deno's access emulation.
RUN /usr/bin/test --version > /dev/null
# Exact historical cleanup IDs must not pass through Deno's numeric stat API.
RUN /usr/bin/stat --version > /dev/null

# Pin DENO_DIR so cached modules and the SQLite native DLL are baked into the image
ENV DENO_DIR=/deno

WORKDIR /app/backend

# Copy workspace config (needed for import resolution)
COPY deno.json deno.lock /app/
COPY shared/ /app/shared/
COPY backend/ .

# Copy built frontend assets and its deno.json (workspace member config required by Deno)
COPY frontend/deno.json /app/frontend/deno.json
COPY --from=builder /app/frontend/dist/ /app/frontend/dist/

# Cache TypeScript modules
RUN deno cache src/server.ts

# Pre-download the @db/sqlite native FFI DLL so first boot doesn't need internet
RUN printf 'import "@db/sqlite";\n' > warmup.ts \
 && deno run --allow-net --allow-ffi --allow-env --allow-write --allow-read warmup.ts \
 && rm warmup.ts

ENV PORT=8080
ENV STATIC_DIR=/app/frontend/dist
ENV DB_PATH=/data/librarian.db

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD deno eval \
  "const port=Deno.env.get('PORT')??'8080';const r=await fetch('http://127.0.0.1:'+port+'/health');Deno.exit(r.ok?0:1)"

# Service-owned deletion uses service APIs; no media or Docker socket mount is required.
CMD ["deno", "run", "--allow-all", "src/server.ts"]
