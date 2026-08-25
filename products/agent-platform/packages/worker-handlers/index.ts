import { handleEvalAuto } from './handlers/evalAuto';
import { handleDocumentIngest } from './handlers/documentIngest';
import { handleKnowledgeInitialIndex } from './handlers/knowledgeInitialIndex';
import { handleKnowledgeSync } from './handlers/knowledgeSync';
import { handleSkillImport } from './handlers/skillImport';
import { runFileIngestion } from './handlers/fileIngest';

type Handler = (body: Record<string, unknown>) => Promise<void>;
type RegisterFn = (type: string, fn: Handler) => void;

export function registerProductHandlers(register: RegisterFn): void {
    register('eval.auto', handleEvalAuto as Handler);
    register('document.ingest', (body) =>
        handleDocumentIngest(body.payload as Parameters<typeof handleDocumentIngest>[0])
    );
    register('knowledge.initial_index', handleKnowledgeInitialIndex as Handler);
    register('knowledge.sync', handleKnowledgeSync as Handler);
    register('skill.import', handleSkillImport);
    // Auto-ingest, triggered by apps/api's POST /:id/confirm on upload — see
    // runFileIngestion's own doc comment for why it's shared with the manual
    // "Ingest" button rather than duplicated.
    register('file.ingest', async (body) => {
        const { tenantId, fileId } = body.payload as { tenantId: string; fileId: string };
        await runFileIngestion({ tenantId, fileId });
    });
}

export { runFileIngestion } from './handlers/fileIngest';
