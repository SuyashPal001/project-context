#!/bin/bash
set -e

cd /home/suyashresearchwork/project-context

# Stop PM2 BEFORE clearing .next so it doesn't crash-loop during the build.
# Without this, PM2 retries thousands of times against the missing server.js.
echo "→ Stopping web-frontend..."
pm2 stop web-frontend

echo "→ Clearing Next.js cache..."
rm -rf apps/web/.next

echo "→ Building web frontend..."
pnpm --filter @serverless-saas/web build

echo "→ Copying static assets..."
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
cp -r apps/web/public apps/web/.next/standalone/apps/web/public

echo "→ Starting web-frontend..."
# Export env vars from .env.local so the standalone server has them at runtime
set -a
[ -f apps/web/.env.local ] && source apps/web/.env.local
set +a

pm2 start /home/suyashresearchwork/project-context/apps/web/.next/standalone/apps/web/server.js \
  --name web-frontend \
  --cwd /home/suyashresearchwork/project-context/apps/web/.next/standalone/apps/web \
  --update-env 2>/dev/null || \
pm2 restart web-frontend --update-env

echo "→ Restarting API..."
pm2 restart api --update-env

echo "✓ Deploy complete"
