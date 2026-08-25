/**
 * Gemini AI Studio adapter (direct REST API, API key auth)
 *
 * Fallback when Vertex AI (ADC) is unavailable.
 * Uses the same Gemini GenerateContentRequest format as the Vertex adapter
 * but calls generativelanguage.googleapis.com with ?key=GEMINI_API_KEY.
 */

import type { ServerResponse } from 'http';
import type { ProviderAdapter } from './base';
import { AdapterError } from './base';
import { latency } from '../metrics.js';
import type {
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIRequest,
  OpenAIStreamChunk,
  OpenAITool,
  OpenAIToolCall,
  OpenAIUsage,
} from '../types';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = process.env.VERTEX_MODEL ?? 'gemini-2.5-flash';

// ---------------------------------------------------------------------------
// OpenAI → Gemini translation (mirrors vertex.ts — kept local to avoid coupling)
// ---------------------------------------------------------------------------

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } }
  | { functionCall: { name: string; args: unknown } }
  | { functionResponse: { name: string; response: unknown } }

type GeminiContent = { role: string; parts: GeminiPart[] }

export function toGeminiParts(content: string | OpenAIContentPart[] | null): GeminiPart[] {
  if (content === null) return []
  if (typeof content === 'string') return [{ text: content }]
  return content.flatMap((block): GeminiPart[] => {
    if (block.type === 'text') return [{ text: block.text ?? '' }]
    if (block.type === 'image_url') {
      const url = block.image_url?.url ?? ''
      const dataUri = url.match(/^data:([^;]+);base64,(.+)$/)
      if (dataUri) return [{ inlineData: { mimeType: dataUri[1], data: dataUri[2] } }]
      return [{ fileData: { mimeType: 'image/jpeg', fileUri: url } }]
    }
    if (block.type === 'input_audio' && block.input_audio) {
      return [{ inlineData: { mimeType: `audio/${block.input_audio.format}`, data: block.input_audio.data } }]
    }
    return []
  })
}

function toGeminiContents(messages: OpenAIMessage[]): {
  systemInstruction: GeminiContent | undefined
  contents: GeminiContent[]
} {
  let systemInstruction: GeminiContent | undefined
  const contents: GeminiContent[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : (msg.content as OpenAIContentPart[]).map((b) => b.text ?? '').join('\n')
      if (systemInstruction) {
        (systemInstruction.parts[0] as { text: string }).text += '\n' + text
      } else {
        systemInstruction = { role: 'user', parts: [{ text }] }
      }
      continue
    }

    if (msg.role === 'tool') {
      const toolCallId = msg.tool_call_id ?? ''
      let functionName = 'unknown'
      for (const prev of messages) {
        if (prev.role === 'assistant' && prev.tool_calls) {
          const tc = prev.tool_calls.find((t) => t.id === toolCallId)
          if (tc) { functionName = tc.function.name; break }
        }
      }
      const resultText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: functionName, response: { result: resultText } } }],
      })
      continue
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      const parts: GeminiPart[] = msg.tool_calls.map((tc) => ({
        functionCall: { name: tc.function.name, args: safeParseJSON(tc.function.arguments) },
      }))
      if (msg.content) parts.unshift({ text: typeof msg.content === 'string' ? msg.content : '' })
      contents.push({ role: 'model', parts })
      continue
    }

    const role = msg.role === 'assistant' ? 'model' : 'user'
    contents.push({ role, parts: toGeminiParts(msg.content) })
  }

  return { systemInstruction, contents }
}

function sanitizeSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(sanitizeSchema)
  const obj = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(obj)) {
    if (key === '$schema' || key === 'propertyNames') continue
    if (key === 'type' && Array.isArray(val)) {
      const nonNull = (val as string[]).filter((t) => t !== 'null')
      out.type = nonNull[0] ?? 'string'
      if (nonNull.length !== val.length) out.nullable = true
      continue
    }
    if (key === 'anyOf' && Array.isArray(val)) {
      const nonNull = val.filter((v) => !(typeof v === 'object' && v !== null && (v as Record<string, unknown>).type === 'null'))
      if (nonNull.length === 1 && val.length !== nonNull.length) {
        const merged = sanitizeSchema(nonNull[0]) as Record<string, unknown>
        Object.assign(out, merged)
        out.nullable = true
        continue
      }
    }
    out[key] = sanitizeSchema(val)
  }
  return out
}

const GEMINI_SERVER_TOOL_NAMES = new Set(['code_execution', 'web_fetch'])

function toGeminiTools(tools: OpenAITool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const result: unknown[] = []
  const functionDeclarations = tools
    .filter((t) => t.type === 'function' && t.function && !GEMINI_SERVER_TOOL_NAMES.has(t.function.name))
    .map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: sanitizeSchema(t.function.parameters),
    }))
  if (functionDeclarations.length > 0) result.push({ functionDeclarations })
  return result.length > 0 ? result : undefined
}

function safeParseJSON(s: string | undefined): Record<string, unknown> {
  try { return JSON.parse(s ?? '{}') } catch { return {} }
}

function makeUsage(meta: Record<string, number> | undefined): OpenAIUsage {
  return {
    prompt_tokens: meta?.promptTokenCount ?? 0,
    completion_tokens: meta?.candidatesTokenCount ?? 0,
    total_tokens: meta?.totalTokenCount ?? 0,
  }
}

function makeStreamChunk(
  id: string, model: string,
  delta: OpenAIStreamChunk['choices'][0]['delta'],
  finishReason: string | null = null,
): OpenAIStreamChunk {
  return {
    id, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function extractToolCalls(parts: GeminiPart[], idPrefix: string): OpenAIToolCall[] {
  return parts
    .filter((p) => (p as { functionCall?: unknown }).functionCall)
    .map((p, i) => {
      const fc = (p as { functionCall: { name: string; args: unknown } }).functionCall
      return {
        id: `call_${idPrefix}_${i}`, type: 'function' as const,
        function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
      }
    })
}

function buildGeminiRequest(openaiReq: OpenAIRequest): Record<string, unknown> {
  const { systemInstruction, contents } = toGeminiContents(openaiReq.messages)
  const generationConfig: Record<string, unknown> = {}
  if (openaiReq.temperature !== undefined) generationConfig.temperature = openaiReq.temperature
  if (openaiReq.max_tokens !== undefined) generationConfig.maxOutputTokens = openaiReq.max_tokens
  if (openaiReq.top_p !== undefined) generationConfig.topP = openaiReq.top_p
  if ((openaiReq as unknown as Record<string, unknown>).thinkingBudget !== undefined) {
    const thinkingBudget = (openaiReq as unknown as Record<string, unknown>).thinkingBudget as number
    generationConfig.thinkingConfig = { thinkingBudget, includeThoughts: thinkingBudget > 0 }
  }
  const req: Record<string, unknown> = { contents }
  if (systemInstruction) req.systemInstruction = systemInstruction
  if (Object.keys(generationConfig).length > 0) req.generationConfig = generationConfig
  const geminiTools = toGeminiTools(openaiReq.tools)
  if (geminiTools) req.tools = geminiTools
  return req
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GeminiAdapter implements ProviderAdapter {
  private readonly apiKey: string

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY ?? ''
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0 && this.apiKey !== 'REPLACE_WITH_YOUR_KEY'
  }

  async handleCompletion(openaiReq: OpenAIRequest, res: ServerResponse): Promise<void> {
    const modelName = openaiReq.model ?? DEFAULT_MODEL
    const body = buildGeminiRequest(openaiReq)
    const hasTools = (openaiReq.tools?.length ?? 0) > 0

    console.log(
      `[gemini-adapter] model=${modelName} messages=${openaiReq.messages.length}` +
        ` hasTools=${hasTools} stream=${openaiReq.stream ?? false}`,
    )

    if (openaiReq.stream) {
      await this.handleStream(modelName, body, res)
    } else {
      await this.handleNonStream(modelName, body, res)
    }
  }

  private async handleNonStream(modelName: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const url = `${GEMINI_BASE}/models/${modelName}:generateContent?key=${this.apiKey}`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new AdapterError(resp.status, `Gemini API ${resp.status}: ${text.slice(0, 300)}`)
    }

    const data = await resp.json() as Record<string, unknown>
    const candidate = (data.candidates as Record<string, unknown>[])?.[0]
    const parts = ((candidate?.content as Record<string, unknown>)?.parts ?? []) as GeminiPart[]
    const text = parts.map((p) => ((p as { text?: string }).text ?? '')).join('')

    const idSuffix = String(Date.now())
    const toolCalls = extractToolCalls(parts, idSuffix)
    const hasToolCalls = toolCalls.length > 0

    const message: Record<string, unknown> = { role: 'assistant', content: text || null }
    if (hasToolCalls) message.tool_calls = toolCalls

    const response = {
      id: `chatcmpl-${idSuffix}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{ index: 0, message, finish_reason: hasToolCalls ? 'tool_calls' : 'stop' }],
      usage: makeUsage(data.usageMetadata as Record<string, number>),
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  }

  private async handleStream(modelName: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const url = `${GEMINI_BASE}/models/${modelName}:streamGenerateContent?alt=sse&key=${this.apiKey}`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new AdapterError(resp.status, `Gemini API ${resp.status}: ${text.slice(0, 300)}`)
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const id = `chatcmpl-${Date.now()}`
    res.write(`data: ${JSON.stringify(makeStreamChunk(id, modelName, { role: 'assistant', content: '' }))}\n\n`)

    const t0 = Date.now()
    let ttftFired = false
    let totalChars = 0
    let toolCallIndex = 0
    let hasToolCalls = false
    let usageMeta: Record<string, number> | undefined

    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw || raw === '[DONE]') continue

          let chunk: Record<string, unknown>
          try { chunk = JSON.parse(raw) } catch { continue }

          if (chunk.usageMetadata) usageMeta = chunk.usageMetadata as Record<string, number>

          const candidate = (chunk.candidates as Record<string, unknown>[])?.[0]
          const parts = ((candidate?.content as Record<string, unknown>)?.parts ?? []) as GeminiPart[]

          for (const part of parts) {
            const p = part as { text?: string; thought?: boolean; functionCall?: { name: string; args: unknown } }
            if (p.text && p.thought) {
              if (!ttftFired) { latency.observe({ adapter: 'gemini', metric: 'ttft' }, Date.now() - t0); ttftFired = true }
              res.write(`data: ${JSON.stringify(makeStreamChunk(id, modelName, { reasoning_content: p.text }))}\n\n`)
            } else if (p.text) {
              if (!ttftFired) { latency.observe({ adapter: 'gemini', metric: 'ttft' }, Date.now() - t0); ttftFired = true }
              totalChars += p.text.length
              res.write(`data: ${JSON.stringify(makeStreamChunk(id, modelName, { content: p.text }))}\n\n`)
            } else if (p.functionCall) {
              if (!ttftFired) { latency.observe({ adapter: 'gemini', metric: 'ttft' }, Date.now() - t0); ttftFired = true }
              hasToolCalls = true
              const callId = `call_${id}_${toolCallIndex}`
              res.write(`data: ${JSON.stringify(makeStreamChunk(id, modelName, {
                tool_calls: [{
                  index: toolCallIndex, id: callId, type: 'function',
                  function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) },
                }],
              }))}\n\n`)
              toolCallIndex++
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const finalFinishReason = hasToolCalls ? 'tool_calls' : 'stop'
    res.write(`data: ${JSON.stringify(makeStreamChunk(id, modelName, {}, finalFinishReason))}\n\n`)
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelName, choices: [], usage: makeUsage(usageMeta) })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()

    console.log(`[gemini-adapter] stream done model=${modelName} totalChars=${totalChars} toolCalls=${toolCallIndex}`)
  }
}
