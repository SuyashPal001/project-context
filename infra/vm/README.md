# Dev Infrastructure — Cloud-Agnostic VM

Provisions a VM on any cloud with Postgres (pgvector) + Redis + Lakehouse running via Docker Compose.
One command. Works on GCP or AWS.

> **Production uses:** Neon PostgreSQL + Upstash Redis (managed, serverless). This VM setup is for local/team dev where you want self-hosted data services without SaaS costs.

## What runs on the VM

```
docker-compose
├── pgvector/pgvector:pg16   → localhost:5432  (postgres — pgvector needed for AI/agent features)
├── redis:7-alpine           → localhost:6379  (cache/sessions)
└── saarthi-lakehouse        → localhost:8001  (Python FastAPI — Delta Lake for pension records)
```

## Usage

```bash
cd infra/vm

# 1. Copy and fill in your values
cp terraform.tfvars.example terraform.tfvars

# 2. Init
terraform init

# 3. Deploy
terraform apply

# 4. Get connection strings — paste into your .env files
terraform output env_block
```

## Which .env files to update

| Variable | Services |
|---|---|
| `DATABASE_URL` | `apps/api/.env`, `apps/ai-service/.env`, `apps/mcp-server/.env`, `apps/relay/.env` |
| `UPSTASH_REDIS_URL` | `apps/api/.env` (leave `UPSTASH_REDIS_TOKEN` empty for local Redis) |
| `LAKEHOUSE_URL` | `apps/api/.env` (used by the agent API for document retrieval) |

## Adding a new database

SSH into the server and run:
```bash
docker exec serverless-saas-postgres psql -U postgres -c "CREATE DATABASE your_db_name;"
```

## Switching clouds

Change `cloud` in `terraform.tfvars`:
- `cloud = "gcp"` → GCP Compute Engine (`e2-medium`, `asia-south1`)
- `cloud = "aws"` → AWS EC2 (`t3.small`, `ap-south-1`)

Same docker-compose on both.

## Note on Upstash Redis compatibility

In production, `UPSTASH_REDIS_URL` and `UPSTASH_REDIS_TOKEN` point to Upstash's REST-over-HTTP API.
For dev on this VM, `UPSTASH_REDIS_URL` is a standard `redis://` URL and `UPSTASH_REDIS_TOKEN` is empty.
The `@serverless-saas/cache` package handles both transparently.
