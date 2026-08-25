/**
 * Upload a document into the workspace knowledge base.
 *
 * The chat composer is now the only caller: the Knowledge Base UI it was
 * originally extracted from has moved out of the canvas to dev studio, but
 * ingestion itself is unchanged and still runs on every attached document.
 * Chat attachments previously went only to /files/upload, which stores
 * the object but never chunks or embeds it — so a document dropped into chat
 * was invisible to retrieve_documents in every later conversation.
 *
 * Ingestion is workspace-wide: once a file lands here any agent can retrieve it
 * in any future conversation, which is what someone attaching a corpus expects.
 *
 * Keep INGESTIBLE_MIME_TYPES in sync with the mimeType allowlist in
 * products/agent-platform/packages/api/routes/documents.ts.
 */

export const INGESTIBLE_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
];

const INGESTIBLE_EXTENSIONS = ['.pdf', '.docx', '.txt', '.zip'];

export interface IngestedDocument {
  /**
   * Absent when the server reports a duplicate without naming the existing
   * document — there is then nothing to poll for, the content is already in.
   */
  documentId?: string;
  /** True when the server already held this exact content. */
  duplicate: boolean;
}

/** Images, audio and video belong on the message, not in the knowledge base. */
export function isIngestibleDocument(file: File): boolean {
  if (INGESTIBLE_MIME_TYPES.includes(file.type)) return true;
  // Browsers report an empty or generic type for some files; fall back to name.
  const lower = file.name.toLowerCase();
  return INGESTIBLE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function ingestDocument(
  file: File,
  fetchImpl: typeof fetch = fetch
): Promise<IngestedDocument> {
  const hash = await sha256Hex(file);

  const urlRes = await fetchImpl('/api/proxy/api/v1/documents/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, mimeType: file.type }),
  });
  if (!urlRes.ok) throw new Error(`Could not get an upload URL (${urlRes.status})`);
  const { uploadUrl, fileKey } = await urlRes.json();

  const s3Res = await fetchImpl(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  });
  if (!s3Res.ok) throw new Error(`Upload failed (${s3Res.status})`);

  const regRes = await fetchImpl('/api/proxy/api/v1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, mimeType: file.type, fileKey, hash }),
  });

  if (regRes.status === 409) {
    const body = await regRes.json().catch(() => ({}));
    return { documentId: body.documentId, duplicate: true };
  }
  if (!regRes.ok) throw new Error(`Could not add the document to the knowledge base (${regRes.status})`);

  const { documentId } = await regRes.json();
  return { documentId, duplicate: false };
}
