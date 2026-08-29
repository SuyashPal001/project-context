/**
 * The database stores the user-space key ("documents/report.pdf") so the folder
 * browser can work with paths the user recognises. S3 holds it namespaced under
 * the tenant. Both upload and purge derive it here, because a purge that
 * derives its own key can drift into deleting the wrong object.
 */
export function tenantS3Key(tenantId: string, userSpaceKey: string): string {
  return `tenants/${tenantId}/${userSpaceKey}`;
}
