import { db } from '@serverless-saas/database';
import { files, personFolders, tenants } from '@serverless-saas/database/schema';
import { users } from '@serverless-saas/database/schema/auth';
import { storageService } from '@serverless-saas/storage';
import { eq, and } from 'drizzle-orm';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const AGENT_ORCHESTRATOR_URL = process.env.AGENT_ORCHESTRATOR_URL ?? 'http://localhost:3001';

// Moved from apps/api/src/routes/files.ts — Drive's own classification rule,
// not shared with the Knowledge Base document pipeline (products/agent-platform
// /packages/api/routes/documents.ts), which has no equivalent concept.
function classifyDocument(filename: string): string {
  const name = filename.toLowerCase();
  const confidentialKeywords = [
    'ppo', 'pension', 'service_book', 'servicebook',
    'salary', 'gratuity', 'dcrg', 'itr', 'aadhaar',
    'aadhar', 'pan', 'payslip', 'retirement', 'family_pension'
  ];
  if (confidentialKeywords.some(k => name.includes(k))) return 'Confidential';
  return 'Internal';
}

export type FileIngestOutcome = 'not_found' | 'already_processing' | 'already_done' | 'started';

export interface RunFileIngestionParams {
  tenantId: string;
  fileId: string;
  force?: boolean;
}

// Shared by the manual "Ingest" button (apps/api/src/routes/files.ts, called
// synchronously) and the automatic file.ingest worker job (fired from
// POST /:id/confirm on upload) — one implementation, two callers, so the two
// trigger paths can never drift out of sync with each other.
//
// Callers that need retry-on-failure semantics (the SQS worker path) should
// let a thrown error propagate — the row is marked 'failed' first, then the
// error is re-thrown so SQS retries the message. The synchronous manual-button
// caller catches the throw itself and maps it to a 500 response.
export async function runFileIngestion({ tenantId, fileId, force = false }: RunFileIngestionParams): Promise<FileIngestOutcome> {
  const [fileRecord] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
    .limit(1);

  if (!fileRecord) return 'not_found';

  // Idempotency guard — SQS is at-least-once, and a manual click can race an
  // in-flight auto-trigger from the same upload. Never start a second pass
  // over a file that's already processing or done.
  if (fileRecord.ingestionStatus === 'processing') return 'already_processing';
  if (fileRecord.ingestionStatus === 'done' && !force) return 'already_done';

  const [uploader] = await db
    .select({ personalIdentifier: users.personalIdentifier })
    .from(users)
    .where(eq(users.id, fileRecord.uploadedBy ?? ''))
    .limit(1);
  const personalIdentifier = uploader?.personalIdentifier ?? undefined;

  const [tenant] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  await db
    .update(files)
    .set({ ingestionStatus: 'processing', updatedAt: new Date() })
    .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));

  try {
    const buffer = await storageService.downloadFile(tenantId, fileId);
    const filename = fileRecord.name;
    const mimeType = fileRecord.mimeType ?? '';

    let personFolderId: string | undefined;
    let folderIdentifier: string | undefined;
    if (fileRecord.personFolderId) {
      const [pf] = await db
        .select({ id: personFolders.id, identifier: personFolders.identifier })
        .from(personFolders)
        .where(eq(personFolders.id, fileRecord.personFolderId))
        .limit(1);
      if (pf) { personFolderId = pf.id; folderIdentifier = pf.identifier; }
    }

    let extractedText: string | undefined;
    if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
      const parsed = await pdfParse(buffer);
      extractedText = parsed.text;
    } else if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename.endsWith('.docx')
    ) {
      const mmResult = await mammoth.extractRawText({ buffer });
      extractedText = mmResult.value;
    } else if (mimeType === 'text/csv' || filename.endsWith('.csv')) {
      extractedText = buffer.toString('utf-8');
    }

    const relayRes = await fetch(`${AGENT_ORCHESTRATOR_URL}/internal/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId,
        filename,
        mimeType,
        bufferBase64: buffer.toString('base64'),
        extractedText,
        tenantId,
        personalIdentifier: folderIdentifier ?? personalIdentifier,
        personFolderId,
        tenantName: tenant?.name ?? tenantId,
        classification: classifyDocument(filename),
      }),
    });

    if (!relayRes.ok) throw new Error(`Relay returned ${relayRes.status}`);

    const relayData = await relayRes.json() as { ok?: boolean; error?: string };
    if (!relayData.ok) throw new Error(relayData.error ?? 'Workflow failed');

    // Relay processes async and updates ingestionStatus itself — this function
    // only owns the 'processing' handoff, not the terminal 'done' state.
    return 'started';
  } catch (err) {
    await db
      .update(files)
      .set({ ingestionStatus: 'failed', updatedAt: new Date() })
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));
    throw err;
  }
}
