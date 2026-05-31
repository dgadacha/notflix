# Notflix all-in-one bundle

Single Docker image bundling **Notflix + Prowlarr + Flaresolverr** for
self-hosted homelab use. Less correct than a docker-compose with three
images, simpler in exchange.

## Build

```sh
make docker-bundle
# or, directly:
docker build -f Dockerfile.bundle -t notflix-bundle:latest .
```

The build is multi-stage; final image is ~700–900 MB compressed
(Chromium alone is ~300 MB).

## Run

```sh
docker run -d \
  --name notflix \
  -p 43000:43000 \
  -p 9696:9696 \
  -v notflix-data:/data \
  notflix-bundle:latest
```

Then open:

- **Notflix UI**: <http://localhost:43000>
- **Prowlarr UI**: <http://localhost:9696> — first boot redirects to the
  setup wizard. Authentication: pick "Forms (login page)" + set a
  password.
- **Flaresolverr**: <http://localhost:8191> — NOT exposed by default.
  Add `-p 8191:8191` to the `docker run` if you want it reachable from
  outside the container.

## Wire-up

The three are pre-configured to talk to each other on `127.0.0.1`:

- Notflix → Prowlarr: `NOTFLIX_PROWLARR_URL=http://127.0.0.1:9696` (set
  in the Dockerfile env). On first boot, Notflix still needs the
  Prowlarr API key — get it from `Prowlarr → Settings → General → API
  Key` and paste it in `Notflix → Settings → Server config`.
- Prowlarr → Flaresolverr: not auto-configured. Open `Prowlarr →
  Settings → Indexers → + → FlareSolverr` and set the URL to
  `http://127.0.0.1:8191`. Apply.

## Volumes

A single PVC mount at `/data` carries:

- `/data/config.toml`  — Notflix server config
- `/data/notflix.db`   — Notflix SQLite (profiles, history, lists,
  TMDB cache)
- `/data/cache/`       — Notflix ephemeral caches (HLS chunks, sub
  translations, TMDB images)
- `/data/prowlarr/`    — Prowlarr config + indexer db
- `/data/flaresolverr-cache/` — Flaresolverr scratch (unused at the
  moment but reserved)

Back up `/data` → you back up everything.

## Process supervision

A small bash supervisor (`docker/bundle/entrypoint.sh`) starts the
three children in parallel. **If any of them dies, the container
exits** — docker / kubernetes then restarts the whole thing. That's
crash-as-a-feature: a dead Prowlarr starves Notflix of search results,
a dead Flaresolverr starves Prowlarr of Cloudflare-protected indexers.
Restarting them together is the simplest correct behavior.

`tini` is PID 1, so zombie reaping works correctly.

## Resource usage

Memory at idle, on a fresh install:

- Notflix:      ~30–50 MB
- Prowlarr:     ~80–120 MB
- Flaresolverr: ~250 MB (Chrome browser process)
- **Total**:    **~400–450 MB** RAM

Under load (active stream + Prowlarr search hitting a Cloudflare
indexer + active subtitle translation), peak is around **800 MB**.

## Caveats

- **Updates couple the three services** — bumping Prowlarr or
  Flaresolverr means rebuilding the Notflix image.
- **Bigger image** — ~900 MB vs ~250 MB for Notflix alone. Cold pulls
  take noticeably longer.
- **No per-service health checks** — if Flaresolverr's Chromium hangs,
  Prowlarr and Notflix keep running but search via CF-protected
  indexers will time out. Inspect `docker logs` to see which prefix
  (`[flaresolverr]`, `[prowlarr]`, `[notflix]`) is misbehaving.
- **Default config is single-host LAN** — if you want to expose this
  on the public internet, set a password in Notflix's auth and
  configure Prowlarr's authentication (default Prowlarr install
  requires this on first boot anyway).

## When NOT to use the bundle

Use the regular `Dockerfile` (single-service) + a docker-compose with
the official `prowlarr` and `flaresolverr` images if any of the
following apply:

- You're running on Kubernetes with multiple worker nodes — the bundle
  forces all three onto the same pod, no horizontal scaling possible.
- You want to update Prowlarr independently of Notflix.
- You're already running Prowlarr / Flaresolverr elsewhere and just
  want Notflix to point at them.
