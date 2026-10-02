#!/bin/bash
set -e

# Rebuilds, restarts, and smoke-tests mcp-server-pc in one step.
#
# Same reason as apps/inference-gateway/deploy.sh: this service is
# restarted by hand (the root ./deploy.sh does not touch it — see CLAUDE.md), and
# `pm2 restart` alone serves whatever is already in dist/ with no error if a
# rebuild was skipped after the last source edit. mcp-server is a standalone
# npm project (not pnpm) — use npm here, same as everywhere else in this dir.
#
# Run this instead of `npm run build && pm2 restart mcp-server-pc` by hand
# from now on.

cd "$(dirname "$0")"

echo "→ Building mcp-server..."
npm run build

echo "→ Restarting PM2 process..."
pm2 restart mcp-server-pc

echo "→ Smoke-testing live endpoint..."
HEALTH="000"
for _ in $(seq 1 15); do
  HEALTH=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/health || true)
  [ "$HEALTH" = "200" ] && break
  sleep 2
done
if [ "$HEALTH" != "200" ]; then
  echo "✗ /health never returned 200 (last: $HEALTH) — check pm2 logs mcp-server-pc"
  exit 1
fi

echo "✓ mcp-server-pc rebuilt, restarted, and responding (pid: $(pm2 jlist | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.find(p=>p.name==='mcp-server-pc').pid)"))"
