import { sql } from 'drizzle-orm';
import { db } from '../db';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { getInstallationToken, getRepoFileTree, fetchFileContent } from '../lib/github';
import { matchesPattern, getLayer, getFileType, indexFile } from '../lib/knowledgeIndex';

export interface KnowledgeInitialIndexEvent {
  type: 'knowledge.initial_index';
  tenantId: string;
  installationId: number;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  timestamp?: string;
}

export async function handleKnowledgeInitialIndex(body: Record<string, unknown>): Promise<void> {
  const event = body as unknown as KnowledgeInitialIndexEvent;
  const { tenantId, installationId, repoOwner, repoName, defaultBranch } = event;

  console.log(`[knowledge.initial_index] starting ${repoOwner}/${repoName}@${defaultBranch}`);

  const token = await getInstallationToken(installationId);
  const tree = await getRepoFileTree(token, repoOwner, repoName, defaultBranch);

  const relevant = tree.filter((f) => matchesPattern(f.path));
  console.log(`[knowledge.initial_index] ${relevant.length} relevant files of ${tree.length} total`);

  // Wholesale invalidate any prior index for this tenant+repo before re-indexing.
  await db.execute(sql`
    UPDATE knowledge_chunks
    SET invalidated_at = NOW()
    WHERE tenant_id = ${tenantId}::uuid
      AND file_path LIKE ${repoName + '/%'}
      AND invalidated_at IS NULL
  `);

  let totalChunks = 0;
  for (const file of relevant) {
    const content = await fetchFileContent(token, repoOwner, repoName, file.path, defaultBranch);
    if (!content) continue;
    const filePath = `${repoName}/${file.path}`;
    const n = await indexFile({
      tenantId,
      filePath,
      content,
      fileType: getFileType(file.path),
      layer: getLayer(file.path),
      eventType: 'initial_index',
    });
    totalChunks += n;
  }

  await db.execute(sql`
    UPDATE github_repos
    SET last_synced_at = NOW()
    WHERE tenant_id = ${tenantId}::uuid
      AND repo_owner = ${repoOwner}
      AND repo_name = ${repoName}
  `);

  db.insert(auditLog).values({ tenantId, actorId: 'system', actorType: 'system', action: 'knowledge_initial_index_completed', resource: 'github_repo', resourceId: null, metadata: { repoOwner, repoName, defaultBranch, filesProcessed: relevant.length, totalChunks }, traceId: '' }).catch(() => {});
  console.log(`[knowledge.initial_index] done ${repoOwner}/${repoName}: ${totalChunks} chunks across ${relevant.length} files`);
}
