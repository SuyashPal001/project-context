import { files } from '@serverless-saas/database/schema';
import { taskSteps } from '@serverless-saas/agent-schema';
import { eq, asc, and, sql, inArray } from 'drizzle-orm';
import { storageService } from '@serverless-saas/storage';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { embedQuery } from '@serverless-saas/ai';
import { db } from '../db';

export { db };

export const AGENT_ORCHESTRATOR_URL = process.env.AGENT_ORCHESTRATOR_URL!;
export const INTERNAL_SERVICE_KEY = () => process.env.INTERNAL_SERVICE_KEY!;
export const MAX_STEPS_PER_TASK = 20;

const TASK_PII_RULES: RegExp[] = [
    /\b[\w.+\-]+@[\w\-]+\.[a-zA-Z]{2,}\b/g,
    /(?:\+91|91|0)[\s\-]?[6-9]\d{9}\b|\b[6-9]\d{9}\b/g,
    /\b\d{4}[\s\-]\d{4}[\s\-]\d{4}\b|\b\d{12}\b/g,
    /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    /\b[\w.\-]+@[\w.\-]+\b/g,
];

export function sanitizeTaskInput(text: string): string;
export function sanitizeTaskInput(text: string | null | undefined): string | null | undefined;
export function sanitizeTaskInput(text: string | null | undefined): string | null | undefined {
    if (text == null) return text;
    let result = text;
    for (const rule of TASK_PII_RULES) {
        rule.lastIndex = 0;
        result = result.replace(rule, '[MASKED]');
    }
    return result;
}

export function makeLog(traceId: string, taskId: string) {
    return (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) =>
        console.log(JSON.stringify({ level, msg, traceId, taskId, ts: Date.now(), ...data }));
}

const EXTRACTABLE_TYPES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain', 'text/markdown', 'text/csv', 'application/octet-stream',
];

export async function extractAttachments(tenantId: string, fileIds: string[]): Promise<{ attachmentContext: string | null }> {
    if (!fileIds.length) return { attachmentContext: null };

    const fileRows = await db.select().from(files).where(inArray(files.id, fileIds));
    const parts: string[] = [];

    for (const file of fileRows) {
        try {
            const buffer = await storageService.downloadFile(tenantId, file.id);
            const isExtractable = EXTRACTABLE_TYPES.includes(file.mimeType ?? '') || file.name.endsWith('.md') || file.name.endsWith('.txt') || file.name.endsWith('.csv');

            if (isExtractable) {
                let text: string;
                if (file.mimeType === 'application/pdf') {
                    text = (await pdfParse(buffer)).text.trim();
                } else if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.name.toLowerCase().endsWith('.docx')) {
                    text = (await mammoth.extractRawText({ buffer })).value.trim();
                } else {
                    text = buffer.toString('utf-8').trim();
                }
                if (text) parts.push(`[Attachment: ${file.name}]\n${text}`);
            } else {
                const url = await storageService.getDownloadUrl(tenantId, file.id);
                parts.push(`[Attachment: ${file.name} (${file.mimeType ?? 'unknown type'})]\nDownload URL (expires in 1 hour): ${url}`);
            }
        } catch (err) {
            console.error(`[taskWorker] Failed to extract attachment ${file.name}:`, err);
        }
    }

    return { attachmentContext: parts.length > 0 ? parts.join('\n\n---\n\n') : null };
}

export async function getPastSuccessfulPlans(tenantId: string, title: string, description: string | null | undefined, limit = 2): Promise<string | null> {
    const queryText = [title, description].filter(Boolean).join(' ');
    const embedding = await embedQuery(queryText);
    const vectorStr = `[${embedding.join(',')}]`;

    const result = await db.execute(sql`
        SELECT id, title FROM agent_tasks
        WHERE tenant_id = ${tenantId} AND status IN ('done', 'review')
          AND embedding IS NOT NULL
          AND (1 - (embedding <=> ${vectorStr}::vector)) > 0.6
        ORDER BY embedding <=> ${vectorStr}::vector LIMIT ${limit}
    `);

    const rows = (result as any).rows as Array<{ id: string; title: string }>;
    if (!rows || rows.length === 0) return null;

    const sections: string[] = [];
    for (const row of rows) {
        const steps = await db.select({ title: taskSteps.title }).from(taskSteps).where(and(eq(taskSteps.taskId, row.id), eq(taskSteps.status, 'done'))).orderBy(asc(taskSteps.stepNumber));
        if (steps.length > 0) sections.push(`Past task: "${row.title}"\nSteps taken:\n${steps.map((s: { title: string }, i: number) => `${i + 1}. ${s.title}`).join('\n')}`);
    }

    if (sections.length === 0) return null;
    return `---\nContext: Here is how this workspace previously handled similar requests. Use as reference only — adapt to current task.\n\n${sections.join('\n\n')}\n---`;
}
