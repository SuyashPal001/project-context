-- 0032_github_integration.sql
-- Phase 2: GitHub App integration — installations + per-repo bindings.
-- Applied via psql (no drizzle-kit snapshot), mirrors 0031 pattern.

-- Table 1: github_installations
-- Fast lookup: installationId → tenantId, used by webhook receiver routing.
CREATE TABLE github_installations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id BIGINT NOT NULL UNIQUE,
  account_login   TEXT NOT NULL,
  account_type    TEXT NOT NULL, -- 'User' or 'Organization'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_github_installations_tenant
  ON github_installations(tenant_id);
CREATE INDEX idx_github_installations_installation
  ON github_installations(installation_id)
  WHERE deleted_at IS NULL;

-- Table 2: github_repos — one row per repo connected by a tenant.
CREATE TABLE github_repos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  installation_id BIGINT NOT NULL
    REFERENCES github_installations(installation_id),
  repo_owner      TEXT NOT NULL,
  repo_name       TEXT NOT NULL,
  repo_full_name  TEXT NOT NULL,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  status          TEXT NOT NULL DEFAULT 'active',
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE(tenant_id, repo_full_name)
);

CREATE INDEX idx_github_repos_tenant
  ON github_repos(tenant_id);
CREATE INDEX idx_github_repos_installation
  ON github_repos(installation_id);
