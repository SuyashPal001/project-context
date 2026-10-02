#!/bin/bash
set -e

cd /home/suyashresearchwork/project-context

# Same seeding step as the root ./deploy.sh (web+api) — Official skills must
# go live with the code that reads them, and Director only picks up a new
# skill_versions row after the orchestrator restart below. Uses the
# orchestrator's own DATABASE_URL, in a subshell so its env never leaks.
echo "→ Seeding Official skills..."
(
  set -a
  source apps/agent-orchestrator/.env
  set +a
  pnpm --filter @serverless-saas/agent-api db:seed:official-skills
)

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
