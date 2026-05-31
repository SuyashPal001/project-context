import { Hono } from 'hono';
import type { AppEnv } from '@serverless-saas/types';
import { handleGetComments, handleStartStep, handleDeltaStep, handleCompleteStep, handleFailStep } from './tasks.steps';
import { handleCompleteTask, handleFailTask, handleClarifyTask, handleMastraRun, handleSuspendTask, handlePostComment } from './tasks.lifecycle';

const internalTasksRoute = new Hono<AppEnv>();

// Comments
internalTasksRoute.get('/:taskId/comments', handleGetComments);
internalTasksRoute.post('/:taskId/comments', handlePostComment);

// Step lifecycle
internalTasksRoute.post('/:taskId/steps/:stepId/start', handleStartStep);
internalTasksRoute.post('/:taskId/steps/:stepId/delta', handleDeltaStep);
internalTasksRoute.post('/:taskId/steps/:stepId/complete', handleCompleteStep);
internalTasksRoute.post('/:taskId/steps/:stepId/fail', handleFailStep);

// Task lifecycle
internalTasksRoute.post('/:taskId/complete', handleCompleteTask);
internalTasksRoute.post('/:taskId/fail', handleFailTask);
internalTasksRoute.post('/:taskId/clarify', handleClarifyTask);
internalTasksRoute.post('/:taskId/mastra-run', handleMastraRun);
internalTasksRoute.post('/:taskId/suspend', handleSuspendTask);

export default internalTasksRoute;
