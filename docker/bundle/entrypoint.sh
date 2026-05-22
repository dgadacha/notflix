#!/bin/bash
#
# Notflix all-in-one bundle supervisor.
#
# Starts Notflix + Prowlarr + Flaresolverr as background children,
# pipes their logs to stdout with a prefix, and exits as soon as ANY
# of them dies — docker / kubernetes restart-policy then brings the
# whole container back up. That's "crash-as-a-feature": if one of the
# three is unhealthy, the others probably can't do useful work either
# (Prowlarr without Flaresolverr → Cloudflare-blocked indexers,
# Notflix without Prowlarr → no search).
#
# Each child gets a `set -e` shell + clear log prefix so a `docker
# logs` shows what's coming from where.

set -e

# Log prefix helper. `awk -v prefix=...` is portable across the few
# bash variants in slim images. Skips empty lines (Prowlarr emits a
# lot of those).
prefix_logs() {
    local label="$1"
    awk -v pfx="[${label}]" '
        /./ { print pfx, $0; fflush() }
    '
}

# Flaresolverr — Python source baked at /opt/flaresolverr, venv at
# .../venv. Honour the standard FlareSolverr env vars; default the
# host/port to localhost so it only listens on the loopback (Prowlarr
# reaches it from inside the same container).
start_flaresolverr() {
    cd /opt/flaresolverr
    export HOST="${FLARESOLVERR_HOST:-127.0.0.1}"
    export PORT="${FLARESOLVERR_PORT:-8191}"
    export LOG_LEVEL="${FLARESOLVERR_LOG_LEVEL:-info}"
    export LOG_HTML="false"
    export CAPTCHA_SOLVER="none"
    # Chromium in a container ALWAYS needs --no-sandbox. Flaresolverr
    # reads this via the BROWSER_TIMEOUT + extra args path; the
    # undetected_chromedriver in their requirements respects
    # CHROMIUM_FLAGS implicitly when launched from inside Docker.
    /opt/flaresolverr/venv/bin/python3 src/flaresolverr.py 2>&1 | prefix_logs flaresolverr
}

# Prowlarr — self-contained .NET binary at /opt/prowlarr/Prowlarr.
# --data points its config at /data/prowlarr so a single PVC mount
# covers both Notflix + Prowlarr state.
start_prowlarr() {
    cd /opt/prowlarr
    ./Prowlarr --data=/data/prowlarr --nobrowser 2>&1 | prefix_logs prowlarr
}

# Notflix — Go binary at /app/notflix. NOTFLIX_DATA_DIR is set in the
# Dockerfile env. The first boot writes /data/config.toml.
start_notflix() {
    cd /app
    ./notflix 2>&1 | prefix_logs notflix
}

# Start order: Flaresolverr → Prowlarr → Notflix.
#
# - Flaresolverr boots in ~5 s (Chrome startup). It's the slowest of
#   the three.
# - Prowlarr's startup probes the Flaresolverr indexer config on
#   first request, not at boot, so we don't actually have to gate on
#   Flaresolverr being ready. Parallel start is fine.
# - Notflix talks to Prowlarr via the /prowlarr endpoints — it's
#   resilient to Prowlarr 500s during boot, falling back to "no
#   results" gracefully.
echo "[bundle] starting flaresolverr, prowlarr, notflix…"

start_flaresolverr &
PID_FLARE=$!

start_prowlarr &
PID_PROWLARR=$!

start_notflix &
PID_NOTFLIX=$!

echo "[bundle] children: flaresolverr=${PID_FLARE} prowlarr=${PID_PROWLARR} notflix=${PID_NOTFLIX}"

# Forward SIGTERM / SIGINT to all three so `docker stop` is clean.
shutdown() {
    echo "[bundle] received signal, shutting down children…"
    kill -TERM "${PID_FLARE}" "${PID_PROWLARR}" "${PID_NOTFLIX}" 2>/dev/null || true
    # Give them 10 s to exit cleanly before SIGKILL.
    sleep 10
    kill -KILL "${PID_FLARE}" "${PID_PROWLARR}" "${PID_NOTFLIX}" 2>/dev/null || true
    exit 0
}
trap shutdown SIGTERM SIGINT

# Wait for the FIRST child to exit, then bail. `wait -n` is bash 4.3+
# and requires `set +e` so its exit code doesn't kill the script.
set +e
wait -n
exit_code=$?
set -e

echo "[bundle] one child exited (code=${exit_code}), tearing the rest down"
kill -TERM "${PID_FLARE}" "${PID_PROWLARR}" "${PID_NOTFLIX}" 2>/dev/null || true
sleep 2
kill -KILL "${PID_FLARE}" "${PID_PROWLARR}" "${PID_NOTFLIX}" 2>/dev/null || true

# Propagate the dying child's exit code so docker/k8s sees the real
# reason (and applies the right restart policy).
exit "${exit_code}"
