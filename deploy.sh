#!/bin/bash
set -e

cd /home/suyashresearchwork/project-context

# Zero-downtime deploy pattern.
# Standalone's server.js bakes distDir into its require() paths — cannot
# rename after build. Each deploy builds into a fresh, timestamped dist
# and the .next-live symlink is atomically swapped once the new build
# passes a smoke test. PM2's script path is fixed at .next-live/... so
# no re-register is needed. Old build stays on disk for rollback until
# the prune step trims to newest-2.

TS=$(date -u +%Y%m%d-%H%M%S)
DIST_NAME=".next-$TS"
DIST_PATH="apps/web/$DIST_NAME"
STANDALONE="$DIST_PATH/standalone/apps/web"
PROBE_PORT=3099

# Preflight: refuse to build under 3 GB free — a full disk mid-build is
# what corrupted .next in a prior incident.
FREE_MB=$(df --output=avail / | tail -1 | awk '{print int($1/1024)}')
if [ "$FREE_MB" -lt 3072 ]; then
  echo "✗ Only ${FREE_MB}MB free on /. Need ≥3072MB. Clean disk before deploying."
  exit 1
fi

# Build in two steps to avoid the pnpm-filter footgun. `--filter "@web..."`
# combined with `exec next build` runs `next build` in every upstream
# workspace package (which don't have next), silently misbehaving and
# creating distDir in the wrong places. Split: (a) build upstream deps
# via their own build script, (b) build web alone with WEB_DIST_NAME
# picked up by next.config.ts's distDir field. `nice/ionice` gives the
# still-serving web-frontend + api scheduler + I/O time so origin stays
# responsive during the build.
echo "→ Building upstream foundation deps..."
nice -n 10 ionice -c 3 pnpm --filter "@serverless-saas/web..." --filter "!@serverless-saas/web" build

echo "→ Building web frontend into $DIST_NAME (old build keeps serving)..."
WEB_DIST_NAME="$DIST_NAME" nice -n 10 ionice -c 3 pnpm --filter "@serverless-saas/web" exec next build

# Standalone mirrors distDir name inside itself, so static goes under
# $STANDALONE/$DIST_NAME/static — not under a hardcoded ".next/static".
echo "→ Copying static + public into standalone tree..."
cp -r "$DIST_PATH/static" "$STANDALONE/$DIST_NAME/static"
cp -r apps/web/public     "$STANDALONE/public"

# Sanity: refuse to swap if key files missing.
for f in "$STANDALONE/server.js" "$STANDALONE/$DIST_NAME/static" "$DIST_PATH/BUILD_ID"; do
  [ -e "$f" ] || { echo "✗ Missing $f — refusing to swap"; exit 1; }
done

# Boot a probe instance on a private port and hit / — proves the new
# build actually serves before we swap the symlink. Kill it before swap.
echo "→ Smoke test on :$PROBE_PORT..."
set -a
[ -f apps/web/.env.local ] && source apps/web/.env.local
set +a
PORT=$PROBE_PORT HOSTNAME=127.0.0.1 node "$STANDALONE/server.js" &
PROBE_PID=$!
trap "kill $PROBE_PID 2>/dev/null || true" EXIT
code="000"
for _ in $(seq 1 20); do
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:$PROBE_PORT/" || echo 000)
  [ "$code" = "200" ] && break
  sleep 1
done
kill $PROBE_PID 2>/dev/null || true; trap - EXIT
[ "$code" = "200" ] || { echo "✗ New build failed smoke test (got $code) — old build stays live"; exit 1; }

# Atomic swap: ln -sfn replaces the symlink in-place. PM2 already runs
# from apps/web/.next-live/standalone/apps/web/server.js — a reload
# with --update-env re-execs against the new target.
echo "→ Swapping .next-live symlink to $DIST_NAME..."
ln -sfn "$DIST_NAME" apps/web/.next-live

echo "→ Reloading web-frontend..."
pm2 reload web-frontend --update-env

echo "→ Restarting API..."
pm2 restart api --update-env

# Keep the current + previous build only. Prune anything older. The
# `.next-2*` glob matches only timestamped dirs (start with year), not
# the plain `.next` from any pre-migration state.
echo "→ Pruning old builds (keeping newest 2)..."
ls -1dt apps/web/.next-2* 2>/dev/null | tail -n +3 | xargs -r rm -rf

echo ""
echo "✓ Deploy complete — live build: $DIST_NAME"
PREV=$(ls -1dt apps/web/.next-2* 2>/dev/null | sed -n '2p')
if [ -n "$PREV" ]; then
  PREV_NAME=$(basename "$PREV")
  echo "  Rollback (previous build still on disk):"
  echo "    ln -sfn $PREV_NAME apps/web/.next-live && pm2 reload web-frontend --update-env"
else
  echo "  Rollback: no previous build retained yet (this is the first zero-downtime deploy)"
fi
