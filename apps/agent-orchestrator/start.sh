#!/bin/bash
cd /home/suyashresearchwork/project-context/apps/agent-orchestrator
export NODE_EXTRA_CA_CERTS="$(pwd)/supabase-ca.crt"
export NODE_OPTIONS='--dns-result-order=ipv4first'
exec node dist/index.js
