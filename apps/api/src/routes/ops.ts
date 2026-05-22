import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { handleListTenants, handleGetTenant, handlePatchTenant, handleGetAudit } from './ops.tenants';
import { handleListProviders, handleCreateProvider, handlePatchProvider } from './ops.providers';
import { handleListOverrides, handleCreateOverride, handleRevokeOverride } from './ops.overrides';
import { handleKnowledgeGaps, handleEvalScores, handleToolPerformance, handleEvalsResults } from './ops.intelligence';
import { handleFinops, handleOverview } from './ops.finops';
import { handleListTeam, handleCreateTeamMember, handleDeleteTeamMember } from './ops.team';
import { handleListFairnessReviews, handleOpsRunFairness, handleListResponseAudits } from './ops.fairness';

export const opsRoutes = new Hono<AppEnv>();

// Tenants
opsRoutes.get('/tenants', handleListTenants);
opsRoutes.get('/tenants/:id', handleGetTenant);
opsRoutes.patch('/tenants/:id', handlePatchTenant);

// Audit
opsRoutes.get('/audit', handleGetAudit);

// LLM Providers
opsRoutes.get('/providers', handleListProviders);
opsRoutes.post('/providers', handleCreateProvider);
opsRoutes.patch('/providers/:id', handlePatchProvider);

// Feature Overrides
opsRoutes.get('/overrides', handleListOverrides);
opsRoutes.post('/overrides', handleCreateOverride);
opsRoutes.post('/overrides/:id/revoke', handleRevokeOverride);

// Agent Intelligence
opsRoutes.get('/agent-intelligence/knowledge-gaps', handleKnowledgeGaps);
opsRoutes.get('/agent-intelligence/eval-scores', handleEvalScores);
opsRoutes.get('/agent-intelligence/tool-performance', handleToolPerformance);
opsRoutes.get('/evals/results', handleEvalsResults);

// FinOps + Overview
opsRoutes.get('/finops', handleFinops);
opsRoutes.get('/overview', handleOverview);

// Team management
opsRoutes.get('/team', handleListTeam);
opsRoutes.post('/team', handleCreateTeamMember);
opsRoutes.delete('/team/:userId', handleDeleteTeamMember);

// Fairness reviews
opsRoutes.get('/fairness', handleListFairnessReviews);
opsRoutes.post('/fairness/:agentId/run', handleOpsRunFairness);
opsRoutes.get('/fairness/response-audits', handleListResponseAudits);
