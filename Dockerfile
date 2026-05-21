# syntax=docker/dockerfile:1.7
# Multi-stage: build the React frontend, embed it into the Go binary, ship a slim runtime.

############################
# 1) Build the React frontend
############################
FROM node:20-bookworm-slim AS web-builder
WORKDIR /app/notflix-web

COPY seanime-web/package.json seanime-web/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY seanime-web/ ./
# Skip tsgo (the upstream codebase has many pre-existing TS errors that don't
# block dev mode); just bundle with rsbuild.
RUN npx --yes rsbuild build
# Output ends up in /app/notflix-web/out

############################
# 2) Build the Go binary with embedded web/
############################
FROM golang:1.26-bookworm AS go-builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
# main.go uses //go:embed all:web — needs the web/ dir to exist at compile time.
COPY --from=web-builder /app/notflix-web/out ./web

# CGO is required (mattn/go-sqlite3, etc.). Builds a dynamically-linked binary.
RUN CGO_ENABLED=1 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/notflix ./

############################
# 3) Runtime
############################
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -m -d /home/notflix -s /sbin/nologin notflix

WORKDIR /app
COPY --from=go-builder /out/notflix /app/notflix

# Datadir defaults to /data (mounted PVC in k8s). Pre-seed config.toml with the
# port community extensions hardcode (43211) and bind on 0.0.0.0 so other pods
# / Cloudflare Tunnel can reach us.
# Note: when /data is a PVC mount this file is shadowed at runtime — the k8s
# initContainer rewrites it on every start with the canonical [server] block.
RUN mkdir -p /data \
 && printf "[server]\nhost = \"0.0.0.0\"\nport = 43211\n" > /data/config.toml \
 && chown -R notflix:notflix /app /data

USER notflix
EXPOSE 43211
VOLUME ["/data"]

ENTRYPOINT ["/app/notflix"]
CMD ["--datadir=/data"]
