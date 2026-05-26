#!/usr/bin/env bash
# Bootstraps a Strapi v5 reference admin at /tmp/strapi-parity-ref/ and
# leaves it running on http://localhost:1337. Idempotent: if the cached
# project exists with healthy node_modules, the script skips create-strapi
# and just starts the dev server.
#
# Per docs/plans/2026-05-23-001-feat-strapi-pixel-parity-admin-plan.md U1.

set -euo pipefail

REF_DIR="${STRAPI_PARITY_DIR:-/tmp/strapi-parity-ref}"
PORT="${STRAPI_PARITY_PORT:-1337}"
ADMIN_EMAIL="${STRAPI_PARITY_ADMIN_EMAIL:-parity@example.com}"
ADMIN_PASSWORD="${STRAPI_PARITY_ADMIN_PASSWORD:-Parity-Demo-1}"
ADMIN_FIRSTNAME="${STRAPI_PARITY_ADMIN_FIRSTNAME:-Parity}"
ADMIN_LASTNAME="${STRAPI_PARITY_ADMIN_LASTNAME:-Admin}"

log() { printf '[parity:strapi] %s\n' "$*" >&2; }

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    log "Node is required on PATH. Install Node 20+ first."
    exit 1
  fi
  local node_major
  node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  if [ "$node_major" -lt 20 ]; then
    log "Node 20+ required (found $(node --version))."
    exit 1
  fi
  # Strapi reference uses npm: pnpm v11 blocks Strapi's native postinstalls
  # (better-sqlite3, sharp, esbuild, @swc/core, core-js-pure) and the
  # `pnpm approve-builds` gate is interactive — incompatible with unattended
  # capture. The reference Strapi is throwaway /tmp scratch; the rest of our
  # monorepo continues to use pnpm/bun per CLAUDE.md.
  if ! command -v npm >/dev/null 2>&1; then
    log "npm is required on PATH for the Strapi reference install."
    exit 1
  fi
}

create_if_missing() {
  # Health checks: package.json + node_modules + a completion sentinel that
  # only exists after a successful pnpm install. This addresses the "half
  # populated cache" hazard (residual finding #1).
  if [ -d "$REF_DIR" ] \
     && [ -f "$REF_DIR/package.json" ] \
     && [ -d "$REF_DIR/node_modules" ] \
     && [ -f "$REF_DIR/.parity-create-done" ]; then
    log "Reusing cached Strapi project at $REF_DIR"
    return 0
  fi

  log "Creating fresh Strapi v5 project at $REF_DIR (this can take 5+ minutes)"
  rm -rf "$REF_DIR"
  # Flags drift across Strapi releases; --help probe first so failures are diagnosable.
  npx --yes create-strapi@latest --help >/dev/null 2>&1 || {
    log "Could not invoke 'npx create-strapi@latest --help'. Network/registry issue?"
    exit 1
  }

  npx --yes create-strapi@latest \
    "$REF_DIR" \
    --quickstart \
    --no-run \
    --skip-cloud \
    --no-example \
    --typescript \
    --use-npm
  if [ ! -f "$REF_DIR/package.json" ]; then
    log "create-strapi did not produce a package.json at $REF_DIR"
    exit 1
  fi
  # Drop the completion sentinel so future runs can trust the cache.
  date +%s > "$REF_DIR/.parity-create-done"
}

write_admin_register_payload() {
  cat <<EOF
{
  "email": "$ADMIN_EMAIL",
  "password": "$ADMIN_PASSWORD",
  "firstname": "$ADMIN_FIRSTNAME",
  "lastname": "$ADMIN_LASTNAME"
}
EOF
}

write_seed_payload() {
  # Two CTs (Article, Author) + one record each. POSTed to Strapi's
  # content-type-builder + REST APIs once the admin is registered.
  cat <<'EOF'
{
  "contentTypes": [
    {
      "displayName": "Article",
      "singularName": "article",
      "pluralName": "articles",
      "draftAndPublish": true,
      "attributes": {
        "title": { "type": "string", "required": true },
        "slug": { "type": "uid", "targetField": "title" },
        "body": { "type": "richtext" },
        "cover": { "type": "media", "multiple": false, "allowedTypes": ["images"] },
        "author": { "type": "relation", "relation": "manyToOne", "target": "api::author.author", "inversedBy": "articles" }
      }
    },
    {
      "displayName": "Author",
      "singularName": "author",
      "pluralName": "authors",
      "draftAndPublish": false,
      "attributes": {
        "name": { "type": "string", "required": true },
        "email": { "type": "email" },
        "articles": { "type": "relation", "relation": "oneToMany", "target": "api::article.article", "mappedBy": "author" }
      }
    }
  ],
  "records": {
    "authors": [
      { "name": "Ada Lovelace", "email": "ada@example.com" }
    ],
    "articles": [
      { "title": "Hello Strapi", "slug": "hello-strapi", "body": "Reference content for parity diff." }
    ]
  }
}
EOF
}

start_strapi() {
  log "Starting Strapi dev server on :$PORT"
  pushd "$REF_DIR" >/dev/null
  # Strapi reads PORT env var. Background it and record the PID so trap can clean up.
  PORT="$PORT" npm run develop &
  STRAPI_PID=$!
  echo "$STRAPI_PID" > "$REF_DIR/.parity-strapi.pid"
  popd >/dev/null

  log "Strapi PID: $STRAPI_PID (recorded at $REF_DIR/.parity-strapi.pid)"
  log "Admin URL: http://localhost:$PORT/admin"
  log "Default credentials (first run): $ADMIN_EMAIL / $ADMIN_PASSWORD"

  # Wait up to 180s for the HTTP listener. Each curl probe is capped at 5s
  # to avoid one slow probe eating the whole budget.
  local deadline=$(( $(date +%s) + 180 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "http://localhost:$PORT/admin" >/dev/null 2>&1; then
      log "Strapi is up."
      return 0
    fi
    sleep 2
  done
  log "Timed out waiting for Strapi. Check $REF_DIR for boot errors."
  return 1
}

register_admin_if_needed() {
  # Strapi's /admin/init reports whether an admin user already exists. If
  # hasAdmin is true, skip registration; if false, POST the registration
  # payload so first-time captures can authenticate.
  local init
  init="$(curl -fsS --max-time 10 "http://localhost:$PORT/admin/init" 2>/dev/null || echo '')"
  if [ -z "$init" ]; then
    log "WARNING: /admin/init unreachable; skipping admin registration."
    return 0
  fi
  if echo "$init" | grep -q '"hasAdmin":true'; then
    log "Admin user already exists; skipping registration."
    return 0
  fi
  log "Registering parity admin user ($ADMIN_EMAIL)..."
  local response
  response="$(curl -fsS --max-time 10 -X POST \
    -H "Content-Type: application/json" \
    -d @"$REF_DIR/.parity-admin.json" \
    "http://localhost:$PORT/admin/register-admin" 2>/dev/null || echo '')"
  if [ -z "$response" ]; then
    log "WARNING: admin registration failed (no response). Capture will likely land on /admin/register."
    return 1
  fi
  log "Admin registered."
}

main() {
  require_node
  create_if_missing
  write_admin_register_payload > "$REF_DIR/.parity-admin.json"
  write_seed_payload > "$REF_DIR/.parity-seed.json"
  log "Admin/register payload: $REF_DIR/.parity-admin.json"
  log "Seed payload (apply after first admin login): $REF_DIR/.parity-seed.json"
  start_strapi
  register_admin_if_needed
}

main "$@"
