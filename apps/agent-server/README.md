# agent-server

Container provisioning API. Launches per-tenant OpenClaw
Docker containers and manages port assignments.

Runs on GCP VM port 3003. Internal only.

## Deploy (GCP VM)
cd /opt/agent-server && git pull && npm run build && pm2 restart agent-server
