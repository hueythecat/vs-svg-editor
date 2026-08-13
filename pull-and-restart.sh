#!/usr/bin/env bash
# Deploy hook: pull main, rebuild the web export if anything changed, reload pm2.
#
# The server runs the production export (dist/), not the Metro dev server, so a git
# pull on its own ships nothing — `expo export` is the step that puts new code in
# front of users. That step used to be commented out here, which meant deploys
# silently did nothing.
#
# Safe to run from cron or a webhook: every failure path leaves the previously
# exported build in place and still serving.

set -uo pipefail

APP_NAME="vs-svg-editor"
# Derived from the script's own location rather than hardcoded, so the checkout can
# live anywhere without editing this file.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:-$HOME/logs}"

mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/$APP_NAME.log" 2>&1

log() { echo "$(date '+%Y-%m-%d %H:%M:%S'): $*"; }

cd "$REPO_DIR" || { log "cd to $REPO_DIR failed"; exit 1; }

BEFORE=$(git rev-parse HEAD)
if ! git pull origin main; then
  log "git pull failed — previous build still serving"
  exit 1
fi
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  log "No changes."
  exit 0
fi

log "Changes detected ($BEFORE -> $AFTER), rebuilding..."
CHANGED=$(git diff --name-only "$BEFORE" "$AFTER")

# npm ci rather than npm install: on a server the lockfile is the source of truth,
# and ci rebuilds node_modules from it instead of mutating what's already there.
if echo "$CHANGED" | grep -qE '^package(-lock)?\.json$'; then
  log "Dependencies changed, running npm ci..."
  if ! npm ci; then
    log "npm ci failed — aborting, previous build still serving"
    exit 1
  fi
fi

# Export into a scratch directory and swap it in only once it has completed, so an
# export that dies partway through can't leave a half-written dist/ being served.
STAGE="$REPO_DIR/.dist-staging"
rm -rf "$STAGE"
# The local binary rather than `npx`: the service user that runs this may not have npx
# on PATH even when node is installed, and npx would silently try to fetch a package
# instead of failing outright.
if ! ./node_modules/.bin/expo export --platform web --output-dir "$STAGE"; then
  log "expo export failed — aborting, previous build still serving"
  rm -rf "$STAGE"
  exit 1
fi

rm -rf "$REPO_DIR/dist.old"
[ -d "$REPO_DIR/dist" ] && mv "$REPO_DIR/dist" "$REPO_DIR/dist.old"
mv "$STAGE" "$REPO_DIR/dist"
rm -rf "$REPO_DIR/dist.old"

# Reload from the ecosystem file with --update-env, not by name. Reloading by name
# replays the environment pm2 recorded when the app was first started, so a secret added
# or changed in .env since then never reaches the process: the deploy reports success and
# the route that needs the value keeps failing. Re-reading the config file is what makes
# .env part of a deploy rather than a manual step someone has to remember.
#
# Falls back to the name if there's no config file, for a host that started the app some
# other way — that reload is still better than none.
ECOSYSTEM="$REPO_DIR/ecosystem.config.js"
if [ -f "$ECOSYSTEM" ]; then
  RELOAD=(pm2 reload "$ECOSYSTEM" --update-env)
else
  log "No ecosystem.config.js — reloading by name, .env changes will not be picked up"
  RELOAD=(pm2 reload "$APP_NAME")
fi

if ! "${RELOAD[@]}"; then
  log "pm2 reload failed"
  exit 1
fi

# A reload that "succeeds" while the app crash-loops on boot still reports success to
# pm2, so confirm the process actually answers before calling the deploy done.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8081/health}"
for attempt in $(seq 1 10); do
  if curl -fsS --max-time 3 "$HEALTH_URL" > /dev/null; then
    log "Deployed $AFTER — health check passed"
    exit 0
  fi
  sleep 2
done

log "DEPLOY UNHEALTHY: $HEALTH_URL not responding after reload — check: pm2 logs $APP_NAME"
exit 1
