# Team Onboarding — project-context

> **What this is:** A multi-tenant SaaS platform with an agentic AI layer. The foundation handles auth, tenancy, billing, roles, notifications, webhooks, files, and audit. The agent platform adds async task planning, real-time relay (Mastra), MCP tool integrations, and a Delta Lake data store. Domain: **projectcontext.co**

---

## 1. Prerequisites

### Mac / Linux

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 20 | Runtime |
| pnpm | ≥ 9 | Package manager |
| Docker Desktop | latest | Local Postgres + Redis + Lakehouse |
| AWS CLI | v2 | Deployments + SSM reads |
| AWS SAM CLI | latest | Lambda builds + deploys |
| Terraform | ≥ 1.5 | Infrastructure provisioning |

```bash
# 1. Node.js v22 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.zshrc    # or ~/.bashrc on Linux
nvm install 22 && nvm use 22

# 2. pnpm
npm install -g pnpm

# 3. Docker Desktop — https://www.docker.com/products/docker-desktop

# 4. AWS CLI v2 (Mac)
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg AWSCLIV2.pkg -target /

# 5. AWS SAM CLI (Mac)
brew install aws-sam-cli

# 6. Terraform (Mac)
brew tap hashicorp/tap && brew install hashicorp/tap/terraform
```

Verify:
```bash
node --version      # v22.x.x
pnpm --version      # 9.x.x or 10.x.x
docker --version
aws --version
sam --version
terraform --version # 1.5.x or later
```

---

### Windows

> All commands run in **PowerShell** or **Windows Terminal**.

```powershell
# 1. Node.js v22 — https://nodejs.org/en/download (Windows Installer .msi, v22 LTS)

# 2. pnpm
npm install -g pnpm

# 3. Docker Desktop — https://www.docker.com/products/docker-desktop
# Requires WSL2:
wsl --install
# Restart, then open Docker Desktop

# 4. AWS CLI v2 — https://awscli.amazonaws.com/AWSCLIV2.msi

# 5. AWS SAM CLI — https://github.com/aws/aws-sam-cli/releases/latest (aws-sam-cli-64-bit.msi)

# 6. Terraform — https://developer.hashicorp.com/terraform/install (Windows AMD64)
```

---

## 2. AWS access

You need an AWS IAM user or role with sufficient permissions. Ask your team lead for credentials, then configure:

```bash
aws configure --profile project-context-dev
# Enter: Access Key ID, Secret Access Key, region (ap-south-1), output (json)
```

Set it as default for this session:
```bash
export AWS_PROFILE=project-context-dev
```

---

## 3. Clone and install

```bash
git clone https://github.com/SuyashPal001/project-context.git
cd project-context
pnpm install
```

---

## 4. Start local infrastructure

```bash
docker-compose up -d
```

This starts:
- **Postgres** (`pgvector/pgvector:pg16`) on `localhost:5432` — user: `postgres`, pass: `postgres`, db: `serverless_saas`
- **Redis** on `localhost:6379`
- **Lakehouse** (Python FastAPI + Delta Lake) on `localhost:8001`

Wait ~30 seconds for all services to be healthy:
```bash
docker-compose ps   # all should show "Up"
```

> **Alternative — shared cloud DB:** Ask your team lead for `DATABASE_URL`, `UPSTASH_REDIS_URL`, `UPSTASH_REDIS_TOKEN`, and `LAKEHOUSE_URL`. Paste them into your `.env` files and skip the Docker step.

---

## 5. Configure environment variables

### API

```bash
cp apps/api/.env.example apps/api/.env
```

Minimum values to fill in for local dev:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/serverless_saas
UPSTASH_REDIS_URL=redis://localhost:6379
UPSTASH_REDIS_TOKEN=
COGNITO_USER_POOL_ID=          # from team lead or terraform output
COGNITO_CLIENT_ID=             # from team lead or terraform output
COGNITO_JWKS_URI=https://cognito-idp.ap-south-1.amazonaws.com/<pool_id>/.well-known/jwks.json
FRONTEND_URL=http://localhost:3000
TOKEN_ENCRYPTION_KEY=          # openssl rand -hex 32
INTERNAL_SERVICE_KEY=          # openssl rand -hex 32
PLATFORM_ADMIN_EMAILS=your@email.com
LAKEHOUSE_URL=http://localhost:8001
```

> `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` come from the deployed AWS infrastructure. Get them from your team lead or from AWS Console → Cognito after Terraform has run.

### Web

```bash
cp apps/web/.env.example apps/web/.env.local
```

Minimum values:
```env
NEXT_PUBLIC_COGNITO_CLIENT_ID=        # same as above
NEXT_PUBLIC_COGNITO_DOMAIN=https://project-context-dev.auth.ap-south-1.amazoncognito.com
NEXT_PUBLIC_COGNITO_CALLBACK_URL=http://localhost:3000/auth/callback
NEXT_PUBLIC_API_URL=http://localhost:3001
API_URL=http://localhost:3001
NEXT_PUBLIC_ROOT_DOMAIN=localhost:3000
NEXT_PUBLIC_WS_URL=                   # leave blank for local dev
NEXT_PUBLIC_AGENT_WS_URL=             # leave blank for local dev (relay not needed for basic UI)
```

### Other services (optional for local dev)

| Service | Config | When you need it |
|---|---|---|
| `apps/relay` | `apps/relay/.env.example` → `.env` | Testing agent chat |
| `apps/inference-gateway` | `apps/inference-gateway/.env.example` → `.env` | Testing AI inference |
| `apps/ai-service` | `apps/ai-service/.env.example` → `.env` | Testing document processing |
| `mcp-server/` (root) | `mcp-server/.env.example` → `.env` | Testing Gmail/MCP tools |

---

## 6. Run database migrations and seed

```bash
cd packages/foundation/database
pnpm db:migrate   # creates all tables
pnpm db:seed      # seeds roles, permissions, plans, features, notification templates
cd ../../..       # back to repo root
```

`db:seed` inserts:
- System roles: `owner`, `admin`, `member`, `platform_admin`
- RBAC permissions for all foundation resources
- 12 feature flags (sso, seats, api_keys, webhooks, audit_log, etc.)
- 4 plan tiers: free / starter / business / enterprise
- Notification templates

---

## 7. Start local dev servers

Open two terminals:

```bash
# Terminal 1 — API (port 3001)
cd apps/api && pnpm dev

# Terminal 2 — Web (port 3000)
cd apps/web && pnpm dev
```

Open `http://localhost:3000` → login page.

> **Worker, relay, MCP, inference gateway, agent server:** These are not needed for basic UI/API development. Start them individually only when testing features that require them.

> **Relay (port 3001):** `cd apps/relay && pnpm dev`
> **Inference gateway (port 4001):** `cd apps/inference-gateway && pnpm dev`

---

## 8. First login — become platform admin

1. Sign up at `http://localhost:3000/auth/signup` with the email in `PLATFORM_ADMIN_EMAILS`
2. Verify your email via the Cognito verification email
3. Complete onboarding (create a workspace)
4. You'll automatically be assigned `platform_admin` role via the pre-token Lambda
5. Access the ops console at `http://localhost:3000/ops`

---

## 9. Production deployment (first time)

This section is for whoever is setting up the AWS environment. Skip if your team lead has already done this.

### Step 1 — Bootstrap AWS resources

Creates the S3 buckets and DynamoDB table that SAM and Terraform need to exist before they can run:

```bash
./bootstrap.sh
```

### Step 2 — Seed secrets in AWS Secrets Manager

Before Terraform runs, manually create these secrets in AWS Secrets Manager (region: `ap-south-1`):

| Secret path | Format |
|---|---|
| `project-context/dev/gcp-sa-key` | GCP service account JSON (paste full JSON) |
| `project-context/dev/internal-service-key` | `openssl rand -hex 32` |
| `project-context/dev/token-encryption-key` | `openssl rand -hex 32` |
| `project-context/dev/jira-oauth` | `{"client_id":"...","client_secret":"..."}` |
| `project-context/dev/github-app` | `{"app_id":"...","private_key":"...","webhook_secret":"..."}` |
| `project-context/dev/zoho-oauth` | `{"client_id":"...","client_secret":"..."}` |

> `google-oauth`, `database`, and `cache` are seeded automatically by Terraform — don't create them manually.

### Step 3 — Deploy Lambdas (SAM)

```bash
pnpm install
make build
sam deploy --config-env dev
```

Note the Lambda ARN outputs — you'll need them in the next step.

### Step 4 — Provision infrastructure (Terraform)

```bash
cd infra/terraform/foundation
cp terraform.tfvars.example terraform.tfvars
```

Fill in `terraform.tfvars` — pay attention to:
- Lambda ARNs from Step 3
- `google_client_id` + `google_client_secret` from GCP Console
- `database_url` — your Neon PostgreSQL connection string
- `upstash_redis_rest_url` + `upstash_redis_rest_token` — from Upstash console

```bash
terraform init -backend-config=../environments/dev/backend.hcl
terraform apply
```

### Step 5 — Configure web app env

After Terraform runs, get the Cognito pool/client IDs from the outputs:

```bash
terraform output   # shows cognito_user_pool_id, cognito_client_id, api_gateway_url, etc.
```

Fill `apps/web/.env.local` (or set environment variables on your hosting) with the Terraform output values.

---

## 10. GCP VM services (production)

The following services run on the GCP VM under PM2, not on AWS Lambda:

| Service | PM2 name | Port | Start command |
|---|---|---|---|
| `apps/web` | `web-frontend` | 3000 | `pnpm build` → PM2 |
| `apps/relay` | `agent-relay` | 3001 | `pnpm build` → PM2 |
| `mcp-server/` | `mcp-server` | 3002 | `npm run build` → PM2 |
| `apps/agent-server` | `agent-server` | 3003 | PM2 |
| `apps/ai-service` | `ai-service` | 3004 | PM2 (Python) |
| `apps/inference-gateway` | `inference-gateway` | 4001 | PM2 |
| `apps/lakehouse` | `saarthi-lakehouse` | 8001 | PM2 (Python/uvicorn) |

**Redeploy web after a code change:**
```bash
./deploy.sh
```

**Redeploy relay after a code change:**
```bash
cd apps/relay && npm run build && pm2 restart agent-relay
```

> `mcp-server/` uses npm (not pnpm) — it's a standalone package not in the pnpm workspace.

---

## 11. Adding new things

### Add a database table
```bash
# 1. Create your schema file
touch packages/foundation/database/schema/your-feature.ts

# 2. Export from the barrel
echo "export * from './your-feature';" >> packages/foundation/database/schema/index.ts

# 3. Generate + run migration
cd packages/foundation/database
pnpm db:generate
pnpm db:migrate
```

### Add an API route
```bash
# 1. Create the route file
touch apps/api/src/routes/your-feature.ts

# 2. Mount it in apps/api/src/app.ts
# api.route('/your-feature', yourFeatureRoutes)
```

### Add a dashboard page
```bash
mkdir -p "apps/web/app/[tenant]/dashboard/your-feature"
touch "apps/web/app/[tenant]/dashboard/your-feature/page.tsx"
```

### Add a background job
```bash
# 1. Create the handler
touch apps/worker/src/handlers/yourJob.ts

# 2. Register in apps/worker/src/router.ts
# registerHandler('yourjob.action', handleYourJob)
```

### Add agent platform features
Work inside `products/agent-platform/packages/` — api, schema, worker-handlers. Mount new routes via `agentProduct.mount*Routes()` in `apps/api/src/app.ts`.

---

## 12. Useful commands

```bash
# Build everything
pnpm build
pnpm type-check
pnpm lint

# Dev servers
cd apps/api && pnpm dev              # API on :3001
cd apps/web && pnpm dev              # Web on :3000

# Database
cd packages/foundation/database
pnpm db:migrate                      # run pending migrations
pnpm db:seed                         # seed foundation data
pnpm db:generate                     # regenerate migration after schema change
pnpm db:studio                       # Drizzle Studio GUI

# SAM (Lambda)
make build                           # bundle all Lambdas
sam deploy --config-env dev
sam local start-api                  # local Lambda emulator

# Terraform
cd infra/terraform/foundation
terraform plan
terraform apply

# Dev VM (one-click Postgres + Redis + Lakehouse)
cd infra/vm
cp terraform.tfvars.example terraform.tfvars   # fill in cloud + project
terraform init && terraform apply
terraform output env_block                     # paste into .env files

# Docker (local)
docker-compose up -d                 # start all local services
docker-compose ps                    # check health
docker-compose down                  # stop
```

---

## 13. Key conventions

- **Tenant isolation:** every DB query must filter by `tenantId`. Never query across tenants.
- **Permissions:** gate API routes with `hasPermission(permissions, 'resource', 'action')`
- **Audit log:** write to `audit_log` for any destructive or sensitive action
- **AWS resource naming:** all resources use `project-context-*` prefix — never `serverless-saas`
- **Package imports:** use `@serverless-saas/<pkg>` (internal scope, never hits AWS)
- **SAM before Terraform:** always `sam deploy` first — Terraform reads Lambda ARNs from SSM
- **No hardcoded domains:** use `NEXT_PUBLIC_AGENT_WS_URL`, `NEXT_PUBLIC_API_URL` env vars in web
