# mcp-server

MCP gateway for Gmail, Drive, Calendar, Zoho, Jira.
Uses per-tenant encrypted OAuth credentials from DB.

Runs on GCP VM port 3002. Internal only.

## Deploy (GCP VM)
cd /opt/mcp-server && git pull && npm run build && pm2 restart mcp-server
