#!/usr/bin/env bash
# Boots the hono-cms admin + newsroom CMS for parity capture.
# Reuses already-running ports when present. Seeds one record per CT after
# both ports respond.
#
# Per docs/plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md U2.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ADMIN_PORT="${HONOCMS_PARITY_ADMIN_PORT:-5173}"
CMS_PORT="${HONOCMS_PARITY_CMS_PORT:-8787}"
PARITY_TOKEN="${HONOCMS_PARITY_TOKEN:-admin}"

log() { printf '[parity:honocms] %s\n' "$*" >&2; }

port_listening() {
  local port="$1"
  # macOS lsof on the given port. Returns 0 when something is listening.
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local deadline=$(( $(date +%s) + 90 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$label is reachable: $url"
      return 0
    fi
    sleep 1
  done
  log "Timed out waiting for $label at $url"
  return 1
}

start_cms_if_needed() {
  if port_listening "$CMS_PORT"; then
    log "Reusing existing CMS on :$CMS_PORT"
    return 0
  fi
  log "Starting newsroom CMS on :$CMS_PORT"
  pushd "$REPO_ROOT/examples/newsroom" >/dev/null
  PORT="$CMS_PORT" bun src/dev-server.ts >/tmp/newsroom-parity.log 2>&1 &
  CMS_PID=$!
  popd >/dev/null
  log "CMS PID: $CMS_PID, log: /tmp/newsroom-parity.log"
  wait_for_http "http://localhost:$CMS_PORT/cms/health/live" "newsroom CMS"
}

start_admin_if_needed() {
  if port_listening "$ADMIN_PORT"; then
    log "Reusing existing admin on :$ADMIN_PORT"
    return 0
  fi
  log "Starting admin vite on :$ADMIN_PORT"
  pushd "$REPO_ROOT/apps/admin" >/dev/null
  VITE_CMS_API_URL="http://localhost:$CMS_PORT" \
    bun --bun vite --host 127.0.0.1 --port "$ADMIN_PORT" --strictPort >/tmp/admin-parity.log 2>&1 &
  ADMIN_PID=$!
  popd >/dev/null
  log "Admin PID: $ADMIN_PID, log: /tmp/admin-parity.log"
  wait_for_http "http://localhost:$ADMIN_PORT/" "admin vite"
}

seed_records() {
  log "Seeding parity records via REST"
  bun "$REPO_ROOT/examples/newsroom/src/seed-parity.ts" \
    --cms-url "http://localhost:$CMS_PORT" \
    --token "$PARITY_TOKEN"
}

main() {
  start_cms_if_needed
  start_admin_if_needed
  seed_records
  log "hono-cms parity environment is ready."
  log "  admin: http://localhost:$ADMIN_PORT  (token: $PARITY_TOKEN)"
  log "  cms:   http://localhost:$CMS_PORT"
}

main "$@"
