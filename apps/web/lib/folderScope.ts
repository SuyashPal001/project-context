/**
 * `folderId` is a RAG scope that ends up in a SQL comparison against a uuid
 * column (`document_chunks.person_folder_id`, via retrieveChunks). Postgres
 * rejects anything that is not a uuid outright — `invalid input syntax for type
 * uuid: "null"` — and that error surfaces as a failed tool call, so one bad
 * value breaks document retrieval for the whole conversation rather than for one
 * query.
 *
 * It arrives from a URL a user can edit, so it must be validated at the boundary
 * rather than trusted. Anything invalid is dropped, which yields an unscoped
 * conversation — the same state as never passing one. Dropping cannot widen
 * access: the tenant filter is applied separately and unconditionally.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseFolderId(raw: string | null | undefined): string | undefined {
    if (!raw) return undefined;
    return UUID.test(raw) ? raw : undefined;
}
