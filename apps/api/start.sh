#!/bin/bash
cd /home/suyashresearchwork/project-context/apps/api
exec npx tsx --env-file=.env src/server.ts
