#!/bin/bash
set -e

cd /home/suyashresearchwork/project-context

echo "→ Building workspace dependencies..."
pnpm --filter @serverless-saas/types build
pnpm --filter @serverless-saas/agent-schema build
pnpm --filter @serverless-saas/agent-api build

echo "→ Building agent-orchestrator..."
cd apps/agent-orchestrator
node build.mjs
cd /home/suyashresearchwork/project-context

echo "→ Restarting agent-orchestrator..."
pm2 restart agent-orchestrator --update-env

echo "✓ Deploy complete"
