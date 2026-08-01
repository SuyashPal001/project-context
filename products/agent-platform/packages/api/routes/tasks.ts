import { Hono } from 'hono';
import type { AppEnv } from '@serverless-saas/types';
import { handleListTasks, handleGetTask } from './tasks.list';
import { handleCreateTask } from './tasks.create';
import { handlePlanApprove, handleWorkflowApprove } from './tasks.approval';
import { handlePlanTask, handleClarifyTask, handleVoteTask } from './tasks.actions';
import { handleUpdateTask, handleDeleteTask, handleBulkCreate, handleBulkUpdate } from './tasks.update';
import { handleListComments, handleAddComment } from './tasks.comments';
import { handleGetTimeline } from './tasks.timeline';
export { VALID_USER_TRANSITIONS } from './tasks.constants';

export const tasksRoutes = new Hono<AppEnv>();

// Bulk routes must be registered before /:taskId to avoid shadowing
tasksRoutes.post('/bulk', handleBulkCreate);
tasksRoutes.patch('/bulk', handleBulkUpdate);

// Collection routes
tasksRoutes.get('/', handleListTasks);
tasksRoutes.post('/', handleCreateTask);

// Single-task routes
tasksRoutes.get('/:taskId', handleGetTask);
tasksRoutes.patch('/:taskId', handleUpdateTask);
tasksRoutes.get('/:taskId/timeline', handleGetTimeline);
tasksRoutes.delete('/:taskId', handleDeleteTask);

// Action routes
tasksRoutes.put('/:taskId/plan/approve', handlePlanApprove);
tasksRoutes.put('/:taskId/workflow/approve', handleWorkflowApprove);
tasksRoutes.post('/:taskId/plan', handlePlanTask);
tasksRoutes.post('/:taskId/clarify', handleClarifyTask);
tasksRoutes.post('/:taskId/vote', handleVoteTask);

// Comment routes
tasksRoutes.get('/:taskId/comments', handleListComments);
tasksRoutes.post('/:taskId/comments', handleAddComment);
