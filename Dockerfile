# syntax=docker/dockerfile:1.7
# Notflix — multi-stage build.
#
# Stage 1 bundles the React SPA via rsbuild → ./out
# Stage 2 builds the Go binary with that SPA embedded via //go:embed all:web
# Stage 3 ships the result on a Debian-slim with ffmpeg + ffprobe (needed
# at runtime for HLS chunks + subtitle extraction).
#
# Final image: ~250-300 MB. Backend listens on $NOTFLIX_SERVER_PORT
# (default 43212) and serves both the API and the SPA from the same
# port — same-origin in prod, no CORS to worry about.

############################
# 1) Build the React frontend
############################
FROM node:20-bookworm-slim AS web-builder
WORKDIR /app/notflix-web

# Copy package manifests first so npm install caches across source-only changes.
COPY notflix-web/package.json notflix-web/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY notflix-web/ ./
# ARG bust de cache : passer --build-arg CACHE_DATE=$(date +%s) pour forcer
# un rebuild complet du frontend même si les layers Docker sont en cache.
ARG CACHE_DATE=2026-05-25
RUN npx --yes rsbuild build

############################
# 2) Build the Go binary with embedded web/
############################
FROM golang:1.23-bookworm AS go-builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# main.go uses //go:embed all:web — needs the web/ dir to exist at compile time.
# rsbuild.config.ts overrides the default outDir to "out" (not "dist").
COPY --from=web-builder /app/notflix-web/out ./web

# CGO is required for mattn/go-sqlite3. Strip symbols/DWARF for a smaller binary.
RUN CGO_ENABLED=1 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/notflix ./

############################
# 3) Runtime
############################
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -m -u 999 -d /home/notflix -s /sbin/nologin notflix

WORKDIR /app
COPY --from=go-builder /out/notflix /app/notflix

# /data is the canonical PVC mount in k8s. Datadir resolution: the runtime
# uses $NOTFLIX_DATA_DIR, defaulting to /data here. The initContainer in
# k8s/deployment.yaml runs as root, chowns /data to 999:999, and writes a
# fresh config.toml — that's the source of truth, not anything baked here.
ENV NOTFLIX_DATA_DIR=/data
RUN mkdir -p /data && chown -R notflix:notflix /app /data

USER notflix
EXPOSE 43212
VOLUME ["/data"]

ENTRYPOINT ["/app/notflix"]
