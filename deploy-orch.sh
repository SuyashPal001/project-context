#!/bin/bash
set -e

cd /home/suyashresearchwork/project-context

# TVC disclaimers (overlay_text size "legal") render in Noto Sans, with Noto
# Sans Devanagari as the fontconfig fallback; without them a Hindi disclaimer
# renders as empty tofu boxes. fonts-noto-core ships both on Debian. This only
# checks — it never installs anything (no apt, no sudo) — so a fresh VM still
# deploys; the warning says exactly what to run by hand.
echo "→ Checking disclaimer fonts..."
if ! command -v fc-list >/dev/null 2>&1; then
  echo "⚠ fc-list (fontconfig) not found — cannot verify the Noto Sans / Noto Sans Devanagari fonts disclaimers need. Install with: sudo apt-get install -y fonts-noto-core && fc-cache -f"
elif ! fc-list : family | grep -qE '(^|,)Noto Sans(,|$)' || ! fc-list : family | grep -qE '(^|,)Noto Sans Devanagari(,|$)'; then
  echo "⚠ Noto Sans and/or Noto Sans Devanagari not found — TVC disclaimers (overlay_text size \"legal\") will render wrong or blank, Hindi worst of all. Install with: sudo apt-get install -y fonts-noto-core && fc-cache -f"
fi

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
