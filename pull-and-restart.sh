#!/usr/bin/env bash
# Deploy hook: pull main, rebuild the web export if anything changed, reload pm2.
#
#   ./pull-and-restart.sh             pull main, rebuild only if HEAD moved
#   ./pull-and-restart.sh --no-pull   rebuild the checkout as it stands, unconditionally
#
# The server runs the production export (dist/), not the Metro dev server, so a git
# pull on its own ships nothing — `expo export` is the step that puts new code in
# front of users. That step used to be commented out here, which meant deploys
# silently did nothing.
#
# --no-pull is for the changes a pull would never notice: an edited .env, or a fix
# applied directly on the server to be tried before it's committed. It runs the same
# swap-and-verify path as a real deploy, so the part that can take production down has
# one implementation rather than a hand-rolled copy in a second script.
#
# Safe to run from cron or a webhook: every failure path leaves the previously
# exported build in place and still serving.

set -uo pipefail

# Parsed before the log redirect below, so a typo'd flag reports to the terminal that
# typed it rather than disappearing into the deploy log.
PULL=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    -h|--help) sed -n '2,5p' "${BASH_SOURCE[0]}" | cut -c3-; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

APP_NAME="vs-svg-editor"
# Derived from the script's own location rather than hardcoded, so the checkout can
# live anywhere without editing this file.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:-$HOME/logs}"

mkdir -p "$LOG_DIR"
# Cron and webhooks have no terminal, so everything is written to the log. A manual run
# does have one, and a deploy that prints nothing for the minute the export takes is
# indistinguishable from one that never started — so tee to both when there's a TTY.
if [ -t 1 ]; then
  exec > >(tee -a "$LOG_DIR/$APP_NAME.log") 2>&1
else
  exec >> "$LOG_DIR/$APP_NAME.log" 2>&1
fi

log() { echo "$(date '+%Y-%m-%d %H:%M:%S'): $*"; }

cd "$REPO_DIR" || { log "cd to $REPO_DIR failed"; exit 1; }

# One deploy at a time. Two concurrent runs share .dist-staging, and the second's
# `rm -rf "$STAGE"` deletes the first's export out from under it while it is still being
# written — the swap then puts a half-finished dist/ in front of users and the site 503s
# until someone re-runs it. Easy to trigger by hand: a deploy that seems stuck invites a
# second one in another shell.
#
# Non-blocking rather than queueing. A second run started because the first looked slow
# wants to be told it is redundant, not to silently run again a minute later against a
# tree someone has since changed.
LOCK_FILE="$REPO_DIR/.deploy.lock"
if command -v flock > /dev/null 2>&1; then
  exec 9> "$LOCK_FILE" || { log "cannot open $LOCK_FILE"; exit 1; }
  if ! flock -n 9; then
    log "another deploy is already running — this run is doing nothing"
    exit 1
  fi
else
  # Don't fail the deploy over a missing util-linux; say so and carry on unguarded.
  log "flock not found — concurrent-deploy guard is off for this run"
fi

NEED_NPM_CI=0

if [ "$PULL" = 1 ]; then
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
  if git diff --name-only "$BEFORE" "$AFTER" | grep -qE '^package(-lock)?\.json$'; then
    NEED_NPM_CI=1
  fi
else
  # Unconditional: --no-pull is only ever run because something changed that git can't
  # see, so there is nothing here to compare against and no reason to second-guess it.
  log "--no-pull — rebuilding the checkout as it stands"
  # No commit range to inspect, so the lockfile's mtime stands in for the diff. Also
  # true when node_modules is absent entirely, which wants an install just the same.
  if [ package-lock.json -nt node_modules ]; then
    NEED_NPM_CI=1
  fi
fi

# npm ci rather than npm install: on a server the lockfile is the source of truth,
# and ci rebuilds node_modules from it instead of mutating what's already there.
if [ "$NEED_NPM_CI" = 1 ]; then
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
#
# --clear is not optional here. Metro keys its transform cache on module source, but
# EXPO_PUBLIC_* values are substituted into that transformed output — so editing .env
# without touching any .ts leaves every cached module eligible for reuse and the export
# re-emits the previous bundle, byte for byte, with the old values still inlined. It
# exits 0 and swaps in a "new" build that is the old one. That failure is invisible from
# the outside: right commit, healthy /health, stale behaviour. Since --no-pull exists
# precisely for "an edited .env", the cost of a cold bundle every deploy is worth paying
# to make the script actually do what it promises.
if ! ./node_modules/.bin/expo export --platform web --clear --output-dir "$STAGE"; then
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
# Read here rather than reusing the pull's AFTER, which doesn't exist under --no-pull.
# Matches what app.config.js stamped into the bundle, +dirty and all, so the line in the
# log can be compared against what /api/version reports.
VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
for attempt in $(seq 1 10); do
  if curl -fsS --max-time 3 "$HEALTH_URL" > /dev/null; then
    log "Deployed $VERSION — health check passed"
    # What actually shipped, not what the checkout says. /api/version answers from the
    # constants inlined at export time, so this line distinguishes a real deploy from an
    # export that re-emitted the previous bundle with stale EXPO_PUBLIC_* values — the
    # case where the commit, the health check and pm2 all still report success. Read it
    # after any .env edit: if the flags don't show the change, the export didn't take it.
    #
    # Advisory only. The deploy is already live and healthy by this point, so a failure
    # to read it back is not a reason to report the deploy as failed.
    VERSION_URL="${VERSION_URL:-${HEALTH_URL%/health}/api/version}"
    BUILD=$(curl -fsS --max-time 3 "$VERSION_URL" 2>/dev/null) \
      && log "Build: $BUILD" \
      || log "Build: could not read $VERSION_URL (deploy is healthy regardless)"
    exit 0
  fi
  sleep 2
done

log "DEPLOY UNHEALTHY: $HEALTH_URL not responding after reload — check: pm2 logs $APP_NAME"
exit 1
