#!/bin/bash
cd /home/suyashresearchwork/project-context/apps/api
export NODE_OPTIONS='--dns-result-order=ipv4first'
exec npx tsx --env-file=.env src/server.ts
