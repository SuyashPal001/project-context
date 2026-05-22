# vertex-proxy

OpenAI-compatible HTTP proxy translating requests to
Vertex AI (Gemini) and Anthropic backends.

Runs on GCP VM port 4001. Internal only.

## Deploy (GCP VM)
cd /opt/vertex-proxy && git pull && npm run build && pm2 restart vertex-proxy
