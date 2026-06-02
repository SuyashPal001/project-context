# Launch Checklist — project-context

---

## Pre-Launch

### 1. AWS — Bootstrap (one time)

- [ ] Run `./bootstrap.sh` — creates S3 buckets + DynamoDB table
- [ ] Confirm in AWS Console:
  - S3 `project-context-sam-deployments-dev` exists
  - S3 `project-context-terraform-state` exists (versioning enabled)
  - DynamoDB `project-context-terraform-locks` exists

---

### 2. AWS — Seed Secrets in Secrets Manager (region: ap-south-1)

- [ ] `project-context/dev/gcp-sa-key` → paste GCP service account JSON
- [ ] `project-context/dev/internal-service-key` → `openssl rand -hex 32`
- [ ] `project-context/dev/token-encryption-key` → `openssl rand -hex 32`
- [ ] `project-context/dev/jira-oauth` → `{"client_id":"...","client_secret":"..."}`
- [ ] `project-context/dev/github-app` → `{"app_id":"...","private_key":"...","webhook_secret":"..."}`
- [ ] `project-context/dev/zoho-oauth` → `{"client_id":"...","client_secret":"..."}`

> `google-oauth`, `database`, `cache` are seeded automatically by Terraform — do not create manually.

---

### 3. AWS — Deploy Lambdas (SAM)

- [ ] `pnpm install`
- [ ] `make build`
- [ ] `sam deploy --config-env dev`
- [ ] Note Lambda ARN outputs (needed for terraform.tfvars)

---

### 4. AWS — Provision Infrastructure (Terraform)

- [ ] `cp infra/terraform/foundation/terraform.tfvars.example infra/terraform/foundation/terraform.tfvars`
- [ ] Fill in all values in `terraform.tfvars`:
  - [ ] Lambda ARNs from SAM deploy (step 3)
  - [ ] `google_client_id` + `google_client_secret`
  - [ ] `database_url` (Neon connection string)
  - [ ] `upstash_redis_rest_url` + `upstash_redis_rest_token`
  - [ ] `ws_token_secret` → `openssl rand -hex 32`
  - [ ] `cognito_domain_prefix` (must be globally unique)
  - [ ] All redirect URIs, frontend_url, agent_orchestrator_url, domain values
- [ ] `cd infra/terraform/foundation`
- [ ] `terraform init -backend-config=../environments/dev/backend.hcl`
- [ ] `terraform plan` — review, no surprises
- [ ] `terraform apply`
- [ ] Note outputs: `cognito_user_pool_id`, `cognito_client_id`, `api_gateway_url`, `ws_api_endpoint`

---

### 5. AWS — SES Domain Verification

> Terraform creates the SES identity but AWS requires DNS verification before emails send.

- [ ] In AWS Console → SES → Verified Identities → `mail.projectcontext.co`
- [ ] Add the 3 CNAME records for DKIM to your DNS provider
- [ ] Add the MX record for `bounce.projectcontext.co` to your DNS provider
- [ ] Wait for status to show **Verified** (up to 72 hours for DNS propagation)
- [ ] Request **SES production access** (removes sandbox mode) — AWS Support → Service Limit Increase → SES Sending Limits
  - Without this, emails only deliver to verified addresses

---

### 6. Domain & DNS (projectcontext.co)

- [ ] Point root domain `projectcontext.co` → GCP VM IP (A record)
- [ ] Point `www.projectcontext.co` → GCP VM IP (A record)
- [ ] Point `agent-orchestrator.projectcontext.co` → GCP VM IP (A record)
- [ ] Point API subdomain (or use API Gateway custom domain) → API Gateway URL
- [ ] SSL certificate on NGINX for all above domains (Let's Encrypt / Certbot)
- [ ] Verify NGINX config routes:
  - `:443` → `apps/web` (port 3000)
  - `/relay` or `agent-orchestrator.projectcontext.co` → `apps/agent-orchestrator` (port 3001)
  - `/mcp` → `mcp-server/` (port 3002)
  - `/lakehouse` → `apps/lakehouse` (port 8001)

---

### 7. Google OAuth (GCP Console)

- [ ] APIs & Services → OAuth consent screen → add `projectcontext.co` as authorized domain
- [ ] Credentials → OAuth 2.0 Client → add authorized redirect URIs:
  - `https://projectcontext.co/auth/callback`
  - `https://projectcontext.co/api/v1/integrations/google/callback`
- [ ] Confirm `google_client_id` + `google_client_secret` match what's in `terraform.tfvars`

---

### 8. Other OAuth Apps

- [ ] **Zoho:** Register `https://projectcontext.co/api/v1/integrations/zoho/callback` as redirect URI
- [ ] **Jira (Atlassian):** Register `https://projectcontext.co/api/v1/integrations/jira/callback` as redirect URI
- [ ] **GitHub App:** Update webhook URL to `https://projectcontext.co/api/v1/integrations/github/webhook`

---

### 9. GCP VM — Environment Variables

- [ ] SSH into GCP VM
- [ ] Set up `.env` files for each service (copy from `.env.example`):
  - [ ] `apps/api/.env` — fill Cognito IDs from terraform output, all secrets
  - [ ] `apps/web/.env.local` — fill Cognito IDs, API Gateway URL, WS endpoint
  - [ ] `apps/agent-orchestrator/.env` — fill all vars
  - [ ] `apps/inference-gateway/.env` — fill `VERTEX_PROJECT`, `ANTHROPIC_API_KEY`
  - [ ] `apps/ai-service/.env` — fill `DATABASE_URL`, `INTERNAL_SERVICE_KEY`
  - [ ] `apps/agent-server/.env` — fill orchestrator keys, extensions dir
  - [ ] `mcp-server/.env` — fill Google OAuth creds, `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`

---

### 10. GCP VM — Start All Services

- [ ] `pnpm install` (from repo root)
- [ ] `pnpm build` (from repo root)
- [ ] `cd mcp-server && npm install && npm run build` (standalone npm project)
- [ ] Start all services via PM2:
  ```bash
  pm2 start ecosystem.config.js   # or start each individually
  pm2 save
  pm2 startup                     # auto-restart on VM reboot
  ```
- [ ] Verify all services are up: `pm2 status`

---

### 11. Database — Run Migrations + Seed

- [ ] `cd packages/foundation/database`
- [ ] `pnpm db:migrate` — run all migrations against production Neon DB
- [ ] `pnpm db:seed` — seed roles, permissions, plans, features
- [ ] Verify tables exist in Neon Console

---

### 12. Smoke Test (pre-launch)

- [ ] `https://projectcontext.co` → loads login page
- [ ] Sign up with `PLATFORM_ADMIN_EMAILS` address
- [ ] Verify email arrives (confirms SES is working)
- [ ] Log in → complete onboarding → workspace dashboard loads
- [ ] Access `/ops` → ops console loads
- [ ] Upload a file → confirms S3 presigned URLs work
- [ ] Send a test webhook → confirms SQS worker is processing
- [ ] Lambda CloudWatch logs show no errors

---

## Post-Launch

### 13. Monitoring & Alerting

- [ ] CloudWatch dashboard — confirm Lambda invocations and errors visible
- [ ] Set up CloudWatch alarm notifications → SNS → email/Slack
- [ ] Set up AWS Budgets alert (billing) — catch unexpected cost spikes
- [ ] PM2 monitoring on GCP VM — `pm2 monit` or integrate with Datadog/New Relic
- [ ] Set up uptime monitoring (e.g. UptimeRobot, Better Uptime) for `https://projectcontext.co`

---

### 14. Error Tracking

- [ ] Integrate Sentry (or similar) into:
  - [ ] `apps/web` — Next.js Sentry SDK
  - [ ] `apps/api` — Lambda error capture
  - [ ] `apps/agent-orchestrator` — Node.js Sentry SDK
- [ ] Verify test errors appear in Sentry dashboard

---

### 15. CI/CD Pipeline

- [ ] Create `.github/workflows/deploy.yml`:
  - On push to `main` → `pnpm build` → `make build` → `sam deploy --config-env prod`
- [ ] Create `.github/workflows/ci.yml`:
  - On PR → `pnpm type-check` + `pnpm lint` + `pnpm test`
- [ ] Add GitHub secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

---

### 16. Payment / Billing

- [ ] Wire Stripe or Paddle into `apps/api/src/routes/billing.ts`
  - `POST /billing/upgrade` — charge customer + update subscription
  - `POST /billing/cancel` — cancel with provider + update DB
- [ ] Test upgrade → downgrade → cancel flows end-to-end
- [ ] Verify invoices are generated

---

### 17. Security Hardening

- [ ] Audit log concurrency fix — add `SELECT FOR UPDATE` in `products/agent-platform/packages/api/services/audit-log.ts`
- [ ] Review Cognito password policy (currently: 8 chars, no symbols required)
- [ ] Enable AWS WAF on API Gateway for rate limiting at the edge
- [ ] Review S3 bucket policies — confirm no public access
- [ ] Rotate `internal-service-key` and `token-encryption-key` on a schedule
- [ ] Enable CloudTrail for AWS API audit logging

---

### 18. Backups

- [ ] Neon PostgreSQL — enable point-in-time recovery in Neon Console
- [ ] S3 files bucket — versioning already enabled (done in Terraform)
- [ ] Terraform state — versioning already enabled on state bucket
- [ ] GCP VM — snapshot schedule for persistent disk (lakehouse Delta Lake data)

---

### 19. Performance Baseline

- [ ] Record Lambda cold start times (CloudWatch → Init Duration metric)
- [ ] Record API p50/p95 latency on key routes (`/auth/me`, `/agents`, `/conversations`)
- [ ] Load test agent-orchestrator WebSocket with realistic concurrent connections
- [ ] Confirm Upstash Redis cache hit rate > 80% on entitlements/permissions

---

### 20. Documentation

- [ ] Update `ONBOARDING.md` with any steps that changed during deploy
- [ ] Update `CLAUDE.md` with any architectural decisions made during launch
- [ ] Document PM2 ecosystem config / service restart procedures
- [ ] Share production Cognito Pool ID + Client ID with team
