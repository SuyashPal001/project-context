/**
 * Vertex AI (Gemini) adapter
 *
 * Request translation:  OpenAI messages/tools → Gemini contents/tools
 * Response translation: Gemini functionCall → OpenAI tool_calls
 */

import type { ServerResponse } from 'http';
import { VertexAI } from '@google-cloud/vertexai';
import type {
  Content,
  FunctionDeclaration,
  GenerateContentRequest,
  Part,
  Tool,
  ToolConfig,
} from '@google-cloud/vertexai';
import { FunctionCallingMode } from '@google-cloud/vertexai';

import type { ProviderAdapter } from './base';
import type {
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIStreamChunk,
  OpenAITool,
  OpenAIToolCall,
  OpenAIToolChoice,
  OpenAIUsage,
} from '../types';

const PROJECT = process.env.VERTEX_PROJECT ?? '';
const LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1';
const DEFAULT_MODEL = process.env.VERTEX_MODEL ?? 'gemini-2.5-flash';

const vertexAI = new VertexAI({ project: PROJECT, location: LOCATION });

// Cache model instances by name to avoid repeated SDK allocations
const modelCache = new Map<string, ReturnType<typeof vertexAI.getGenerativeModel>>();

function getModel(name: string) {
  if (!modelCache.has(name)) {
    modelCache.set(name, vertexAI.getGenerativeModel({ model: name }));
  }
  return modelCache.get(name)!;
}

// ---------------------------------------------------------------------------
// OpenAI → Gemini translation
// ---------------------------------------------------------------------------

function toGeminiParts(content: string | OpenAIContentPart[] | null): Part[] {
  if (content === null) return [];
  if (typeof content === 'string') return [{ text: content }];

  return content.flatMap((block): Part[] => {
    if (block.type === 'text') {
      return [{ text: block.text ?? '' }];
    }
    if (block.type === 'image_url') {
      const url = block.image_url?.url ?? '';
      const dataUri = url.match(/^data:([^;]+);base64,(.+)$/);
      if (dataUri) {
        return [{ inlineData: { mimeType: dataUri[1], data: dataUri[2] } }];
      }
      return [{ fileData: { mimeType: 'image/jpeg', fileUri: url } }];
    }
    return [];
  });
}

function toGeminiContents(messages: OpenAIMessage[]): {
  systemInstruction: Content | undefined;
  contents: Content[];
} {
  let systemInstruction: Content | undefined;
  const contents: Content[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content as OpenAIContentPart[]).map((b) => b.text ?? '').join('\n');

      if (systemInstruction) {
        (systemInstruction.parts[0] as { text: string }).text += '\n' + text;
      } else {
        systemInstruction = { role: 'user', parts: [{ text }] };
      }
      continue;
    }

    if (msg.role === 'tool') {
      // Map tool_call_id → function name by scanning prior assistant messages
      const toolCallId = msg.tool_call_id ?? '';
      let functionName = 'unknown';
      for (const prev of messages) {
        if (prev.role === 'assistant' && prev.tool_calls) {
          const tc = prev.tool_calls.find((t) => t.id === toolCallId);
          if (tc) {
            functionName = tc.function.name;
            break;
          }
        }
      }
      const resultText =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: functionName,
              response: { result: resultText },
            },
          },
        ],
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Assistant turn that contains tool calls
      const parts: Part[] = msg.tool_calls.map((tc) => ({
        functionCall: {
          name: tc.function.name,
          args: safeParseJSON(tc.function.arguments),
        },
      }));
      if (msg.content) {
        parts.unshift({ text: typeof msg.content === 'string' ? msg.content : '' });
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    // Regular user / assistant text message
    const role = msg.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: toGeminiParts(msg.content) });
  }

  return { systemInstruction, contents };
}

// Tool names handled outside of functionDeclarations — excluded from function tool list.
// web_search is now handled by Exa (real function call) so it's no longer excluded.
// code_execution and web_fetch map to native Gemini codeExecution/urlContext.
const GEMINI_SERVER_TOOL_NAMES = new Set(['code_execution', 'web_fetch']);

function toGeminiTools(tools: OpenAITool[] | undefined): Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const result: Tool[] = [];

  // Regular function tools (exclude server tools — web_search is handled by Exa,
  // code_execution and web_fetch are handled natively by the LLM provider)
  const functionDeclarations: FunctionDeclaration[] = tools
    .filter((t) => t.type === 'function' && t.function && !GEMINI_SERVER_TOOL_NAMES.has(t.function.name))
    .map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: t.function.parameters as FunctionDeclaration['parameters'],
    }));

  if (functionDeclarations.length > 0) {
    result.push({ functionDeclarations });
  }

  // Native Gemini server tools for code_execution and web_fetch only.
  // web_search is now handled by Exa (real function call) — no googleSearch needed.
  const names = tools.map((t) => t.function?.name);
  if (names.includes('code_execution')) {
    result.push({ codeExecution: {} } as unknown as Tool);
  }
  if (names.includes('web_fetch')) {
    result.push({ urlContext: {} } as unknown as Tool);
  }

  return result.length > 0 ? result : undefined;
}

function toGeminiToolConfig(choice: OpenAIToolChoice | undefined): ToolConfig | undefined {
  if (!choice || choice === 'auto') return undefined;
  if (choice === 'none') return { functionCallingConfig: { mode: FunctionCallingMode.NONE } };
  if (choice === 'required') return { functionCallingConfig: { mode: FunctionCallingMode.ANY } };
  if (typeof choice === 'object' && choice.type === 'function') {
    return {
      functionCallingConfig: {
        mode: FunctionCallingMode.ANY,
        allowedFunctionNames: [choice.function.name],
      },
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Gemini → OpenAI translation
// ---------------------------------------------------------------------------

function makeUsage(meta: Record<string, number> | undefined): OpenAIUsage {
  return {
    prompt_tokens: meta?.promptTokenCount ?? 0,
    completion_tokens: meta?.candidatesTokenCount ?? 0,
    total_tokens: meta?.totalTokenCount ?? 0,
  };
}

/**
 * Build OpenAI tool_calls[] from Gemini parts that contain functionCall.
 *
 * Gemini format:  part.functionCall = { name: string, args: object }
 * OpenAI format:  { id, type: "function", function: { name, arguments: JSON } }
 */
function extractToolCalls(parts: Part[], idPrefix: string): OpenAIToolCall[] {
  return parts
    .filter((p) => (p as { functionCall?: unknown }).functionCall)
    .map((p, i) => {
      const fc = (p as { functionCall: { name: string; args: unknown } }).functionCall;
      return {
        id: `call_${idPrefix}_${i}`,
        type: 'function' as const,
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args ?? {}),
        },
      };
    });
}

function buildNonStreamingResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any,
  model: string,
): OpenAIResponse {
  const candidate = result.response?.candidates?.[0];
  const parts: Part[] = candidate?.content?.parts ?? [];
  const text = parts.map((p) => ((p as { text?: string }).text ?? '')).join('');

  const idSuffix = String(Date.now());
  const toolCalls = extractToolCalls(parts, idSuffix);
  const hasToolCalls = toolCalls.length > 0;

  const message: OpenAIResponse['choices'][0]['message'] = {
    role: 'assistant',
    content: text || null,
  };
  if (hasToolCalls) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${idSuffix}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
      },
    ],
    usage: makeUsage(result.response?.usageMetadata),
  };
}

function makeStreamChunk(
  id: string,
  model: string,
  delta: OpenAIStreamChunk['choices'][0]['delta'],
  finishReason: string | null = null,
): OpenAIStreamChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJSON(s: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(s ?? '{}');
  } catch {
    return {};
  }
}

function buildGeminiRequest(openaiReq: OpenAIRequest): GenerateContentRequest {
  const { systemInstruction, contents } = toGeminiContents(openaiReq.messages);

  const generationConfig: Record<string, unknown> = {};
  if (openaiReq.temperature !== undefined) generationConfig.temperature = openaiReq.temperature;
  if (openaiReq.max_tokens !== undefined) generationConfig.maxOutputTokens = openaiReq.max_tokens;
  if (openaiReq.top_p !== undefined) generationConfig.topP = openaiReq.top_p;

  const request: GenerateContentRequest = { contents };
  if (systemInstruction) request.systemInstruction = systemInstruction;
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

  const geminiTools = toGeminiTools(openaiReq.tools);
  if (geminiTools) request.tools = geminiTools;

  const geminiToolConfig = toGeminiToolConfig(openaiReq.tool_choice);
  if (geminiToolConfig) request.toolConfig = geminiToolConfig;

  return request;
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class VertexAdapter implements ProviderAdapter {
  async handleCompletion(openaiReq: OpenAIRequest, res: ServerResponse): Promise<void> {
    const modelName = openaiReq.model ?? DEFAULT_MODEL;
    const model = getModel(modelName);
    const geminiRequest = buildGeminiRequest(openaiReq);

    const hasImages = openaiReq.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as OpenAIContentPart[]).some((b) => b.type === 'image_url'),
    );
    const hasTools = (openaiReq.tools?.length ?? 0) > 0;

    console.log(
      `[vertex-adapter] model=${modelName} messages=${openaiReq.messages.length}` +
        ` hasImages=${hasImages} hasTools=${hasTools} stream=${openaiReq.stream ?? false}`,
    );

    if (openaiReq.stream) {
      await this.handleStream(model, geminiRequest, modelName, res);
    } else {
      await this.handleNonStream(model, geminiRequest, modelName, res);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleNonStream(model: any, request: GenerateContentRequest, modelName: string, res: ServerResponse): Promise<void> {
    const result = await model.generateContent(request);
    const response = buildNonStreamingResponse(result, modelName);

    console.log(
      `[vertex-adapter] non-stream done model=${modelName}` +
        ` textLen=${response.choices[0]?.message?.content?.length ?? 0}` +
        ` toolCalls=${response.choices[0]?.message?.tool_calls?.length ?? 0}`,
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleStream(model: any, request: GenerateContentRequest, modelName: string, res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const id = `chatcmpl-${Date.now()}`;

    // Role delta first (OpenAI SSE convention)
    res.write(
      `data: ${JSON.stringify(makeStreamChunk(id, modelName, { role: 'assistant', content: '' }))}\n\n`,
    );

    const streamResult = await model.generateContentStream(request);

    let totalChars = 0;
    let toolCallIndex = 0;
    let hasToolCalls = false;
    let lastFinishReason: string | null = null;

    for await (const chunk of streamResult.stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const candidate = (chunk as any).candidates?.[0];
      if (candidate?.finishReason) lastFinishReason = candidate.finishReason;

      const parts: Part[] = candidate?.content?.parts ?? [];

      for (const part of parts) {
        const p = part as { text?: string; functionCall?: { name: string; args: unknown } };

        if (p.text) {
          totalChars += p.text.length;
          res.write(
            `data: ${JSON.stringify(makeStreamChunk(id, modelName, { content: p.text }))}\n\n`,
          );
        } else if (p.functionCall) {
          // Gemini functionCall → OpenAI tool_calls streaming delta
          hasToolCalls = true;
          const callId = `call_${id}_${toolCallIndex}`;
          res.write(
            `data: ${JSON.stringify(
              makeStreamChunk(id, modelName, {
                tool_calls: [
                  {
                    index: toolCallIndex,
                    id: callId,
                    type: 'function',
                    function: {
                      name: p.functionCall.name,
                      arguments: JSON.stringify(p.functionCall.args ?? {}),
                    },
                  },
                ],
              }),
            )}\n\n`,
          );
          toolCallIndex++;
        }
      }
    }

    // Final chunk with correct finish_reason
    const finalFinishReason = hasToolCalls ? 'tool_calls' : 'stop';
    res.write(
      `data: ${JSON.stringify(makeStreamChunk(id, modelName, {}, finalFinishReason))}\n\n`,
    );

    // Usage chunk (empty choices[], usage populated — OpenAI streaming convention)
    const aggregated = await streamResult.response;
    const usage = makeUsage(aggregated?.usageMetadata);
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [],
        usage,
      })}\n\n`,
    );

    res.write('data: [DONE]\n\n');
    res.end();

    console.log(
      `[vertex-adapter] stream done model=${modelName} totalChars=${totalChars}` +
        ` toolCalls=${toolCallIndex} finishReason=${lastFinishReason} usage=${JSON.stringify(usage)}`,
    );
  }
}
