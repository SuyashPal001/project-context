import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import { agentTasks, taskSteps, taskComments, agents } from '@serverless-saas/agent-schema/agents';
import { projectPlans } from '@serverless-saas/agent-schema/pm';
import { githubRepos } from '@serverless-saas/agent-schema/github';
import { users } from '@serverless-saas/database/schema/auth';
import { getMcpRegistry, jsonResponse, errorResponse } from '@serverless-saas/mcp';
import type { McpToolCallResponse, McpAuthContext } from '@serverless-saas/mcp';

const REQUIRED_READ_PERMISSION = ['agent_tasks:read'];

async function loadTaskForTenant(taskId: string, tenantId: string) {
  const [task] = await db.select({
    id: agentTasks.id,
    title: agentTasks.title,
    description: agentTasks.description,
    status: agentTasks.status,
    priority: agentTasks.priority,
    acceptanceCriteria: agentTasks.acceptanceCriteria,
    planApprovedAt: agentTasks.planApprovedAt,
    planApprovedBy: agentTasks.planApprovedBy,
    planId: agentTasks.planId,
    repoId: agentTasks.repoId,
  }).from(agentTasks).where(and(
    eq(agentTasks.id, taskId),
    eq(agentTasks.tenantId, tenantId),
  )).limit(1);
  return task;
}

async function handleStartTask(
  args: Record<string, unknown>,
  auth: McpAuthContext,
): Promise<McpToolCallResponse> {
  const taskId = args.taskId as string;
  if (!taskId) return errorResponse('taskId is required');

  const task = await loadTaskForTenant(taskId, auth.tenantId);
  if (!task) return errorResponse('Task not found');

  const steps = await db.select({
    id: taskSteps.id,
    stepNumber: taskSteps.stepNumber,
    title: taskSteps.title,
    description: taskSteps.description,
    status: taskSteps.status,
    toolName: taskSteps.toolName,
  }).from(taskSteps)
    .where(and(eq(taskSteps.taskId, taskId), eq(taskSteps.tenantId, auth.tenantId)))
    .orderBy(asc(taskSteps.stepNumber));

  let project: { id: string; title: string; description: string | null; context: string | null } | null = null;
  if (task.planId) {
    const [plan] = await db.select({
      id: projectPlans.id,
      title: projectPlans.title,
      description: projectPlans.description,
      context: projectPlans.context,
    }).from(projectPlans).where(and(
      eq(projectPlans.id, task.planId),
      eq(projectPlans.tenantId, auth.tenantId),
      isNull(projectPlans.deletedAt),
    )).limit(1);
    project = plan ?? null;
  }

  let repo: { fullName: string; defaultBranch: string; cloneUrl: string } | null = null;
  if (task.repoId) {
    const [repoRow] = await db.select({
      repoFullName: githubRepos.repoFullName,
      defaultBranch: githubRepos.defaultBranch,
    }).from(githubRepos).where(and(
      eq(githubRepos.id, task.repoId),
      eq(githubRepos.tenantId, auth.tenantId),
      isNull(githubRepos.deletedAt),
    )).limit(1);
    repo = repoRow
      ? { fullName: repoRow.repoFullName, defaultBranch: repoRow.defaultBranch, cloneUrl: `https://github.com/${repoRow.repoFullName}.git` }
      : null;
  }

  return jsonResponse({
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      acceptanceCriteria: task.acceptanceCriteria,
    },
    plan: {
      approved: Boolean(task.planApprovedAt),
      approvedBy: task.planApprovedBy,
      steps,
    },
    project,
    repo,
  });
}

async function handleGetTaskThread(
  args: Record<string, unknown>,
  auth: McpAuthContext,
): Promise<McpToolCallResponse> {
  const taskId = args.taskId as string;
  if (!taskId) return errorResponse('taskId is required');

  const task = await loadTaskForTenant(taskId, auth.tenantId);
  if (!task) return errorResponse('Task not found');

  const comments = await db
    .select({
      id: taskComments.id,
      authorId: taskComments.authorId,
      authorType: taskComments.authorType,
      authorName: sql<string>`COALESCE(${users.name}, ${agents.name}, 'Unknown')`,
      content: taskComments.content,
      parentId: taskComments.parentId,
      createdAt: taskComments.createdAt,
    })
    .from(taskComments)
    .leftJoin(users, and(eq(taskComments.authorId, users.id), eq(taskComments.authorType, 'member')))
    .leftJoin(agents, and(sql`${taskComments.authorId} = ${agents.id}`, eq(taskComments.authorType, 'agent')))
    .where(and(eq(taskComments.taskId, taskId), eq(taskComments.tenantId, auth.tenantId)))
    .orderBy(asc(taskComments.createdAt));

  return jsonResponse({ comments });
}

let registered = false;

export function registerAgentPlatformMcpTools(): void {
  if (registered) return;
  registered = true;

  const registry = getMcpRegistry();

  registry.register(
    {
      name: 'start_task',
      description: "Fetch everything needed to start work on a task: title/description/status, resolved plan steps, linked project context, and repo reference. Does not change the task's status or assignment.",
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string', description: 'The task ID to start' } },
        required: ['taskId'],
      },
      requiredPermissions: REQUIRED_READ_PERMISSION,
    },
    handleStartTask,
  );

  registry.register(
    {
      name: 'get_task_thread',
      description: 'Fetch the full comment history for a task.',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string', description: 'The task ID whose thread to fetch' } },
        required: ['taskId'],
      },
      requiredPermissions: REQUIRED_READ_PERMISSION,
    },
    handleGetTaskThread,
  );
}

/** Test-only: allows re-registration after resetMcpRegistry() in tests. */
export function __resetRegisteredFlagForTests(): void {
  registered = false;
}
