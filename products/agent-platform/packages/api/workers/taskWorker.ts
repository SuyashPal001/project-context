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
            // `attempt` is computed once by the publisher (tasks.approval.ts's
            // handlePlanApprove) at enqueue time and carried in the message so
            // an SQS redelivery of this exact message replays the SAME attempt
            // rather than recomputing a higher one — see the comment there.
            await handleExecution(taskId, traceId, message.attempt as number | undefined);
        }
    }
};
