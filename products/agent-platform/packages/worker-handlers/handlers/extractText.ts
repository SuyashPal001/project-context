/** Formats the ingest extractor reads as UTF-8 text rather than handing to a
 *  binary parser.
 *
 *  This has to stay at least as wide as apps/api's isIngestibleDocument, which
 *  decides what gets enqueued on upload: anything enqueued but not extracted
 *  reaches the orchestrator with no extractedText, and embedStep throws
 *  "No text content extracted — 0 chunks produced" — so the file is marked
 *  failed rather than ingested. A .txt did exactly that.
 *
 *  Any text/* is covered rather than enumerated, since the failure mode of
 *  missing one is a silent ingest failure, and the cost of reading an unusual
 *  text type as text is nothing.
 */
export function isPlainTextDocument(mimeType: string, filename: string): boolean {
  const ct = mimeType.toLowerCase();
  const name = filename.toLowerCase();
  return ct.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.csv') || name.endsWith('.md');
}
