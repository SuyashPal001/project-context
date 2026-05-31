import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { handleListTenants, handleGetTenant, handlePatchTenant, handleGetAudit } from './ops.tenants';
import { handleListOverrides, handleCreateOverride, handleRevokeOverride } from './ops.overrides';
import { handleListTeam, handleCreateTeamMember, handleDeleteTeamMember } from './ops.team';
import { handleObsSummary, handleObsWorkflows, handleObsCosts, handleObsAuditVolume, handleObsAgents, handleObsInferenceLatency } from './ops.observability';

// Foundation ops routes only. Product (agent-platform) adds its own ops routes
// via agentProduct.mountOpsRoutes() — providers, agent-intelligence, finops,
// overview, fairness, agent-templates.

export const opsRoutes = new Hono<AppEnv>();

// Tenants
opsRoutes.get('/tenants', handleListTenants);
opsRoutes.get('/tenants/:id', handleGetTenant);
opsRoutes.patch('/tenants/:id', handlePatchTenant);

// Audit
opsRoutes.get('/audit', handleGetAudit);

// Feature Overrides
opsRoutes.get('/overrides', handleListOverrides);
opsRoutes.post('/overrides', handleCreateOverride);
opsRoutes.post('/overrides/:id/revoke', handleRevokeOverride);

// Team management
opsRoutes.get('/team', handleListTeam);
opsRoutes.post('/team', handleCreateTeamMember);
opsRoutes.delete('/team/:userId', handleDeleteTeamMember);

// Observability (platform-wide or ?tenantId= scoped)
opsRoutes.get('/observability/summary', handleObsSummary);
opsRoutes.get('/observability/workflows', handleObsWorkflows);
opsRoutes.get('/observability/costs', handleObsCosts);
opsRoutes.get('/observability/audit-volume', handleObsAuditVolume);
opsRoutes.get('/observability/agents', handleObsAgents);
opsRoutes.get('/observability/inference-latency', handleObsInferenceLatency);
