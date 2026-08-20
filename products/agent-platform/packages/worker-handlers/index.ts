import { handleEvalAuto } from './handlers/evalAuto';
import { handleDocumentIngest } from './handlers/documentIngest';
import { handleKnowledgeInitialIndex } from './handlers/knowledgeInitialIndex';
import { handleKnowledgeSync } from './handlers/knowledgeSync';
import { handleSkillImport } from './handlers/skillImport';

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
}
