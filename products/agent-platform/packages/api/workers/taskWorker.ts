import type { SQSHandler } from 'aws-lambda';
import { initRuntimeSecrets } from '@serverless-saas/secrets';
import { handlePlanning } from './taskWorker.planning';
import { handleExecution } from './taskWorker.execution';

let secretsInitialised = false;

export const handler: SQSHandler = async (event) => {
    if (!secretsInitialised) {
        await initRuntimeSecrets();
        secretsInitialised = true;
    }

    for (const record of event.Records) {
        const message = JSON.parse(record.body);
        const { type, taskId, traceId = taskId } = message;

        if (type === 'plan_task' || type === 'replan_task') {
            await handlePlanning(
                taskId,
                traceId,
                message.extraContext as string | undefined,
                message.feedbackHistoryMap as Record<string, Array<{ round: number; feedback: string; generalInstruction: string | null; replannedAt: string }>> | undefined,
            );
        } else if (type === 'execute_task') {
            await handleExecution(taskId, traceId);
        }
    }
};
