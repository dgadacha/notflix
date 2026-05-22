#!/usr/bin/env bash
#
# Migrate from the single-service Notflix setup → bundle.
#
# Three sources of state to merge into the bundle's single PVC:
#
#   1. Notflix data    — k8s PVC `notflix-data` in namespace `notflix`
#                        (config.toml, notflix.db, /data/cache/*)
#   2. Prowlarr config — either k8s PVC OR a local Docker volume
#                        ($HOME/.notflix-data/prowlarr or named volume)
#   3. Flaresolverr    — stateless, nothing to migrate
#
# Strategy: spin a temp "tar pump" pod in each namespace that mounts
# the source PVC, and pipe through kubectl exec into a matching pod
# in the bundle namespace. No file ever touches the local machine.
#
# Usage:
#   ./migrate.sh                   — interactive, prompts before each step
#   ./migrate.sh --yes             — non-interactive, runs everything
#   ./migrate.sh --skip-notflix    — skip Notflix PVC migration
#   ./migrate.sh --skip-prowlarr   — skip Prowlarr migration
#   ./migrate.sh --prowlarr-volume <vol>  — local Docker volume name (not k8s)
#
# Run from the project root: bash k8s/bundle/migrate.sh

set -euo pipefail

OLD_NS=${OLD_NS:-notflix}
NEW_NS=${NEW_NS:-notflix-bundle}
OLD_DEPLOY=${OLD_DEPLOY:-notflix}
NEW_DEPLOY=${NEW_DEPLOY:-notflix-bundle}
OLD_PVC=${OLD_PVC:-notflix-data}
NEW_PVC=${NEW_PVC:-notflix-bundle-data}
PROWLARR_NS=${PROWLARR_NS:-${OLD_NS}}
PROWLARR_PVC=${PROWLARR_PVC:-}                   # empty = no k8s prowlarr PVC
PROWLARR_VOLUME=${PROWLARR_VOLUME:-}             # local Docker volume name (alt)

INTERACTIVE=true
SKIP_NOTFLIX=false
SKIP_PROWLARR=false

# ─── arg parsing ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes|-y)              INTERACTIVE=false ; shift ;;
        --skip-notflix)        SKIP_NOTFLIX=true ; shift ;;
        --skip-prowlarr)       SKIP_PROWLARR=true ; shift ;;
        --prowlarr-pvc)        PROWLARR_PVC="$2" ; shift 2 ;;
        --prowlarr-volume)     PROWLARR_VOLUME="$2" ; shift 2 ;;
        --prowlarr-ns)         PROWLARR_NS="$2" ; shift 2 ;;
        -h|--help)
            sed -n '4,30p' "$0"; exit 0 ;;
        *)
            echo "unknown flag: $1" ; exit 1 ;;
    esac
done

confirm() {
    $INTERACTIVE || return 0
    read -p "$1 [y/N] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]]
}

log() { echo -e "\033[1;36m[migrate]\033[0m $*"; }
ok()  { echo -e "\033[1;32m  ✓\033[0m $*"; }
warn(){ echo -e "\033[1;33m  ⚠\033[0m $*"; }
fail(){ echo -e "\033[1;31m  ✗\033[0m $*" ; exit 1; }

# ─── preflight ──────────────────────────────────────────────────────
log "Preflight checks"
command -v kubectl >/dev/null || fail "kubectl not in PATH"
kubectl version --client >/dev/null 2>&1 || fail "kubectl can't reach cluster"
ok "kubectl OK"

# Make sure the bundle namespace + PVC exist (apply manifests if not).
if ! kubectl get ns "${NEW_NS}" >/dev/null 2>&1; then
    log "Bundle namespace ${NEW_NS} doesn't exist yet."
    if confirm "Apply k8s/bundle/{namespace,pvc}.yaml now?"; then
        kubectl apply -f k8s/bundle/namespace.yaml
        kubectl apply -f k8s/bundle/pvc.yaml
        ok "Bundle namespace + PVC created"
    else
        fail "Bundle namespace required. Aborting."
    fi
fi

if ! kubectl -n "${NEW_NS}" get pvc "${NEW_PVC}" >/dev/null 2>&1; then
    log "Bundle PVC ${NEW_PVC} missing. Applying k8s/bundle/pvc.yaml…"
    kubectl apply -f k8s/bundle/pvc.yaml
fi
ok "Bundle PVC ready"

# ─── helper: tar-pump pod creator + waiter ──────────────────────────
make_pump_pod() {
    local ns="$1" name="$2" pvc="$3"
    cat <<EOF | kubectl -n "${ns}" apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  labels: { app: notflix-migrate }
spec:
  restartPolicy: Never
  containers:
    - name: tar
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      volumeMounts:
        - { name: data, mountPath: /data }
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: ${pvc}
EOF
    kubectl -n "${ns}" wait --for=condition=Ready pod/"${name}" --timeout=180s
}

remove_pump_pod() {
    local ns="$1" name="$2"
    kubectl -n "${ns}" delete pod "${name}" --ignore-not-found=true --wait=false || true
}

# ─── Step 1: scale down the old Notflix deploy (RWO PVC must be free) ─
if [[ "${SKIP_NOTFLIX}" == "false" ]]; then
    log "Step 1 — scale down ${OLD_NS}/${OLD_DEPLOY}"
    if kubectl -n "${OLD_NS}" get deploy "${OLD_DEPLOY}" >/dev/null 2>&1; then
        kubectl -n "${OLD_NS}" scale deploy "${OLD_DEPLOY}" --replicas=0
        # Wait for the pod to actually unmount the PVC.
        sleep 5
        kubectl -n "${OLD_NS}" wait --for=delete pod -l app="${OLD_DEPLOY}" --timeout=60s || true
        ok "Old Notflix deployment scaled to 0"
    else
        warn "No deployment ${OLD_NS}/${OLD_DEPLOY} found — skipping scale-down"
    fi
fi

# Also scale down the bundle deploy (if running) so the new PVC is free.
if kubectl -n "${NEW_NS}" get deploy "${NEW_DEPLOY}" >/dev/null 2>&1; then
    log "Scaling bundle deploy down too (will rescale at the end)"
    kubectl -n "${NEW_NS}" scale deploy "${NEW_DEPLOY}" --replicas=0
    sleep 5
fi

# ─── Step 2: copy Notflix PVC → bundle PVC root ────────────────────
if [[ "${SKIP_NOTFLIX}" == "false" ]]; then
    log "Step 2 — copy ${OLD_NS}/${OLD_PVC} → ${NEW_NS}/${NEW_PVC} (root)"
    confirm "Proceed?" || fail "aborted"

    make_pump_pod "${OLD_NS}" "migrate-source-notflix" "${OLD_PVC}"
    make_pump_pod "${NEW_NS}" "migrate-dest" "${NEW_PVC}"

    log "Streaming tar (may take a few minutes for big caches)…"
    kubectl -n "${OLD_NS}" exec migrate-source-notflix -- \
        sh -c "tar -cf - -C /data ." \
      | kubectl -n "${NEW_NS}" exec -i migrate-dest -- \
        sh -c "tar -xf - -C /data"

    ok "Notflix data copied"

    remove_pump_pod "${OLD_NS}" "migrate-source-notflix"
fi

# ─── Step 3: copy Prowlarr config ──────────────────────────────────
if [[ "${SKIP_PROWLARR}" == "false" ]]; then
    log "Step 3 — copy Prowlarr config into ${NEW_NS}/${NEW_PVC}:/prowlarr"

    # Make sure dest pod is up if Notflix step didn't run.
    if [[ "${SKIP_NOTFLIX}" == "true" ]]; then
        make_pump_pod "${NEW_NS}" "migrate-dest" "${NEW_PVC}"
    fi

    # Create the /data/prowlarr subdir on the dest pod.
    kubectl -n "${NEW_NS}" exec migrate-dest -- mkdir -p /data/prowlarr

    if [[ -n "${PROWLARR_PVC}" ]]; then
        # K8s PVC source
        log "Source = k8s PVC ${PROWLARR_NS}/${PROWLARR_PVC}"
        make_pump_pod "${PROWLARR_NS}" "migrate-source-prowlarr" "${PROWLARR_PVC}"

        confirm "Proceed?" || fail "aborted"
        kubectl -n "${PROWLARR_NS}" exec migrate-source-prowlarr -- \
            sh -c "tar -cf - -C /data ." \
          | kubectl -n "${NEW_NS}" exec -i migrate-dest -- \
            sh -c "tar -xf - -C /data/prowlarr"

        remove_pump_pod "${PROWLARR_NS}" "migrate-source-prowlarr"
        ok "Prowlarr k8s PVC copied"

    elif [[ -n "${PROWLARR_VOLUME}" ]]; then
        # Local Docker volume source — needs Docker on this machine.
        command -v docker >/dev/null || fail "docker not in PATH"

        log "Source = local Docker volume ${PROWLARR_VOLUME}"
        log "Streaming tar via local docker run + kubectl exec…"
        confirm "Proceed?" || fail "aborted"

        # Run a temp alpine container, mount the source volume, tar it
        # to stdout, pipe into kubectl exec on the dest pod.
        docker run --rm \
            -v "${PROWLARR_VOLUME}":/from:ro \
            alpine:3.19 \
            sh -c "tar -cf - -C /from ." \
          | kubectl -n "${NEW_NS}" exec -i migrate-dest -- \
            sh -c "tar -xf - -C /data/prowlarr"

        ok "Prowlarr Docker volume copied"

    else
        warn "No Prowlarr source specified. Pass --prowlarr-pvc or --prowlarr-volume."
        warn "Skipping. You'll need to redo indexers in Prowlarr's UI after first boot."
    fi
fi

# ─── Step 4: tear down + restart bundle ────────────────────────────
log "Step 4 — cleanup pump pod + restart bundle deploy"

remove_pump_pod "${NEW_NS}" "migrate-dest"

if kubectl -n "${NEW_NS}" get deploy "${NEW_DEPLOY}" >/dev/null 2>&1; then
    kubectl -n "${NEW_NS}" scale deploy "${NEW_DEPLOY}" --replicas=1
    ok "Bundle deploy scaled to 1"
    kubectl -n "${NEW_NS}" rollout status deploy/"${NEW_DEPLOY}" --timeout=300s || true
else
    warn "Bundle deployment doesn't exist yet — run \`make deploy-bundle\` separately."
fi

echo
ok "DONE."
echo
echo "Next steps:"
echo "  1. Tail logs to verify all 3 services started:"
echo "       make bundle-logs"
echo "  2. Open Notflix:     http://notflix-bundle.maiz.local (or via Cloudflare Tunnel)"
echo "  3. Open Prowlarr:    make bundle-prowlarr-ui  then http://localhost:9696"
echo "  4. Once you've validated 24-48 h of normal use, delete the old:"
echo "       kubectl delete ns ${OLD_NS}                    # nukes old PVC too!"
echo "       docker volume rm <old-prowlarr-volume>         # if you used --prowlarr-volume"
