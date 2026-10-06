#!/bin/bash
cd /home/suyashresearchwork/project-context/apps/api
# Drop any PORT inherited from PM2 or the deploy shell so apps/api/.env wins.
unset PORT
export NODE_OPTIONS='--dns-result-order=ipv4first'
exec npx tsx --env-file=.env src/server.ts
