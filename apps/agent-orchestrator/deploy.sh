#!/bin/bash
set -e

# Rebuilds, restarts, and smoke-tests agent-orchestrator in one step.
#
# Same reason as apps/inference-gateway/deploy.sh: this service is
# restarted by hand (the root ./deploy.sh does not touch it — see CLAUDE.md), and
# `pm2 restart` alone serves whatever is already in dist/ with no error if a
# rebuild was skipped after the last source edit.
#
# Run this instead of `node build.mjs && pm2 restart agent-orchestrator` by
# hand from now on.

cd "$(dirname "$0")"

echo "→ Building agent-orchestrator..."
node build.mjs

echo "→ Restarting PM2 process..."
pm2 restart agent-orchestrator

echo "→ Smoke-testing live endpoint (up to 30s for Mastra's agent registry to load)..."
HEALTH="000"
for _ in $(seq 1 15); do
  HEALTH=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/health || true)
  [ "$HEALTH" = "200" ] && break
  sleep 2
done
if [ "$HEALTH" != "200" ]; then
  echo "✗ /health never returned 200 (last: $HEALTH) — check pm2 logs agent-orchestrator"
  exit 1
fi

echo "✓ agent-orchestrator rebuilt, restarted, and responding (pid: $(pm2 jlist | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.find(p=>p.name==='agent-orchestrator').pid)"))"
