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
pm2 start web-frontend

echo "✓ Deploy complete"
