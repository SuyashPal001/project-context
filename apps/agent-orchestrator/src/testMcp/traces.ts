// Route 5 of the internal test MCP: reads which tools/agents ran in a
// conversation straight from Mastra's observability store (span traces),
// not mastra_messages or pm2 logs -- traces are the source of truth for
// "did X get called" (see consulate-demo/BUILD_BRIEF.md). chatStream.ts
// sets the memory thread to conversationId (requestContext.set(MASTRA_
// THREAD_ID_KEY, conversationId)), and that lands on every span's
// `threadId` field, so that is what we filter listTraces on.
//
// listTraces only returns root spans -- one per trace, `parentSpanId IS
// NULL` (see @mastra/pg's observability/v-next/traces.ts) -- so every
// matching trace is expanded with getTrace to reach the tool/agent spans
// inside it. The span-type strings (`tool_call`, `mcp_tool_call`,
// `agent_run`) are @mastra/core's SpanType enum values, confirmed against
// the installed node_modules/@mastra/core/dist/observability/types/tracing.d.ts.
import type { ListTracesArgs, ListTracesResponse, GetTraceResponse } from '@mastra/core/storage'
import { SpanType } from '@mastra/core/observability'

/** The minimum surface `readToolSpans` needs off a Mastra observability store. */
export type ObservabilityLike = {
  listTraces(args: ListTracesArgs): Promise<ListTracesResponse>
  getTrace(args: { traceId: string }): Promise<GetTraceResponse | null>
}

export type ToolSpan = {
  name: string
  type: string
  startedAt: string
  durationMs: number | null
  error?: string
  input?: unknown
  output?: unknown
}

const INCLUDED_SPAN_TYPES: string[] = [SpanType.TOOL_CALL, SpanType.MCP_TOOL_CALL, SpanType.AGENT_RUN]
const MAX_FIELD_LENGTH = 2000

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string)
}

// input/output/error land as arbitrary JSON on a span. Stringify anything
// that isn't already a string, then cap at 2,000 chars so one trace can
// never flood Claude's context.
function truncateField(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH)}…` : text
}

/**
 * Reads the tool/agent spans for a conversation, oldest first. `limit` bounds
 * both how many traces are fetched (listTraces pagination) and how many
 * spans are returned, since a single conversation can span many turns/traces.
 */
export async function readToolSpans(store: ObservabilityLike, conversationId: string, limit = 50): Promise<ToolSpan[]> {
  const { spans: roots } = await store.listTraces({
    filters: { threadId: conversationId },
    pagination: { perPage: limit },
  })

  const out: ToolSpan[] = []
  for (const root of roots) {
    let trace: GetTraceResponse | null
    try {
      trace = await store.getTrace({ traceId: root.traceId })
    } catch {
      // A trace can disappear mid-fan-out (retention sweep, race with a
      // delete). Skip it and keep whatever spans we already gathered rather
      // than aborting the whole read over one bad trace.
      continue
    }
    if (!trace) continue
    for (const span of trace.spans) {
      if (!INCLUDED_SPAN_TYPES.includes(span.spanType)) continue
      const startedAt = asDate(span.startedAt)
      const endedAt = span.endedAt ? asDate(span.endedAt) : null
      out.push({
        name: span.name,
        type: span.spanType,
        startedAt: startedAt.toISOString(),
        durationMs: endedAt ? endedAt.getTime() - startedAt.getTime() : null,
        ...(span.error != null ? { error: truncateField(span.error) } : {}),
        ...(span.input != null ? { input: truncateField(span.input) } : {}),
        ...(span.output != null ? { output: truncateField(span.output) } : {}),
      })
    }
  }

  // Keep the most recent `limit` spans -- not the oldest -- then return them
  // oldest-first: sort newest-first, slice to the cap, reverse.
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return out.slice(0, limit).reverse()
}
