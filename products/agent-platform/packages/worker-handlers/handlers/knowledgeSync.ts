import { sql } from 'drizzle-orm';
import { db } from '../db';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { getInstallationToken, getPRFiles, fetchFileContent } from '../lib/github';
import { matchesPattern, getLayer, getFileType, indexFile } from '../lib/knowledgeIndex';

export interface KnowledgeSyncEvent {
  type: 'knowledge.sync';
  tenantId: string;
  installationId: number;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  commitSha: string;
  timestamp: string;
}

export async function handleKnowledgeSync(body: Record<string, unknown>): Promise<void> {
  const event = body as unknown as KnowledgeSyncEvent;
  const { tenantId, installationId, repoOwner, repoName, prNumber, commitSha } = event;

  const token = await getInstallationToken(installationId);
  const files = await getPRFiles(token, repoOwner, repoName, prNumber);

  const relevant = files.filter((f) => matchesPattern(f.filename) && f.status !== 'removed');
  if (relevant.length === 0) {
    console.log(`[knowledge.sync] No relevant files in PR #${prNumber} (${repoOwner}/${repoName})`);
    return;
  }

  console.log(`[knowledge.sync] ${relevant.length} files to re-index for PR #${prNumber}`);

  let totalChunks = 0;
  for (const file of relevant) {
    const content = await fetchFileContent(token, repoOwner, repoName, file.filename, commitSha);
    if (!content) {
      console.warn(`[knowledge.sync] could not fetch ${file.filename}@${commitSha}`);
      continue;
    }
    const filePath = `${repoName}/${file.filename}`;
    const n = await indexFile({
      tenantId,
      filePath,
      content,
      fileType: getFileType(file.filename),
      layer: getLayer(file.filename),
      eventType: 'pr_merge',
    });
    totalChunks += n;
    console.log(`[knowledge.sync] ${file.filename} → ${n} chunks`);
  }

  await db.execute(sql`
    UPDATE github_repos
    SET last_synced_at = NOW()
    WHERE tenant_id = ${tenantId}::uuid
      AND repo_owner = ${repoOwner}
      AND repo_name = ${repoName}
  `);

  db.insert(auditLog).values({ tenantId, actorId: 'system', actorType: 'system', action: 'knowledge_sync_completed', resource: 'github_repo', resourceId: null, metadata: { repoOwner, repoName, prNumber, filesProcessed: relevant.length, totalChunks }, traceId: '' }).catch(() => {});
  console.log(`[knowledge.sync] done PR #${prNumber}: ${totalChunks} chunks across ${relevant.length} files`);
}
