#!/bin/bash
# Mastra Studio UI — platform admin observability
#
# Runs the Studio browser app on :3010.
# Connects to the Mastra API mounted on the relay at :3001/studio.
#
# Start with PM2:
#   pm2 start apps/agent-orchestrator/scripts/start-studio.sh --name mastra-studio
#
# Or run directly:
#   bash apps/agent-orchestrator/scripts/start-studio.sh

npx mastra studio \
  --port 3010 \
  --server-host projectcontext.co \
  --server-port 443 \
  --server-protocol https \
  --server-api-prefix /studio \
  --request-context-presets ./apps/agent-orchestrator/presets.json
