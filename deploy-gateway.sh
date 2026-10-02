#!/bin/bash
set -e

# Rebuilds, restarts, and smoke-tests inference-gateway in one step.
#
# Exists because `pm2 restart` alone serves whatever is already in dist/ —
# editing src/*.ts and restarting without rebuilding first looks identical to
# a successful deploy (process comes up fine) but silently keeps serving old
# code. Hit this for real on 2026-10-02: video.ts's Vertex image-to-video
# fallback was built, type-checked and unit-tested, restarted, and only
# failed — against the live HTTP endpoint — because the rebuild step had
# been skipped after the last source edit. `npx tsx` script tests don't
# catch this either, since they run straight from src/, bypassing dist/
# entirely.
#
# Run this instead of `npm run build && pm2 restart inference-gateway` by
# hand from now on.

cd "$(dirname "$0")/apps/inference-gateway"

echo "→ Building inference-gateway..."
npm run build

echo "→ Restarting PM2 process..."
pm2 restart inference-gateway

echo "→ Smoke-testing live endpoint..."
HEALTH="000"
for _ in $(seq 1 15); do
  HEALTH=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4001/health || true)
  [ "$HEALTH" = "200" ] && break
  sleep 2
done
if [ "$HEALTH" != "200" ]; then
  echo "✗ /health never returned 200 (last: $HEALTH) — check pm2 logs inference-gateway"
  exit 1
fi

echo "✓ inference-gateway rebuilt, restarted, and responding (pid: $(pm2 jlist | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.find(p=>p.name==='inference-gateway').pid)"))"
