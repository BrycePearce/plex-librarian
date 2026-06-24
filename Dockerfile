# ── Stage 1: build frontend ───────────────────────────────────────────────────
FROM denoland/deno:2.8.3 AS builder

WORKDIR /app

# Copy workspace manifests first so dep downloads are cached separately from source
COPY deno.json deno.lock ./
COPY shared/ ./shared/
COPY frontend/ ./frontend/

RUN deno install && deno task build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM denoland/deno:2.8.3

USER root

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
RUN deno cache src/main.ts

# Pre-download the @db/sqlite native FFI DLL so first boot doesn't need internet
RUN printf 'import "@db/sqlite";\n' > warmup.ts \
 && deno run --allow-net --allow-ffi --allow-env --allow-write --allow-read warmup.ts \
 && rm warmup.ts

ENV PORT=8080
ENV STATIC_DIR=/app/frontend/dist
ENV DB_PATH=/data/librarian.db

VOLUME ["/data"]
EXPOSE 8080

CMD ["deno", "run", \
     "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", \
     "src/main.ts"]
