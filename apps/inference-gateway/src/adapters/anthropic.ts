/**
 * Anthropic (Claude) adapter
 *
 * Request translation:  OpenAI messages/tools → Anthropic messages/tools
 * Response translation: Anthropic response → OpenAI format
 * Streaming:            Anthropic SSE events → OpenAI delta chunks
 */

import type { ServerResponse } from 'http';
import Anthropic from '@anthropic-ai/sdk';
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

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// OpenAI → Anthropic translation
// ---------------------------------------------------------------------------

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type AnthropicToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string };
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

function contentToString(content: string | OpenAIContentPart[] | null): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  return content.map((b) => b.text ?? '').join('');
}

function toAnthropicMessages(messages: OpenAIMessage[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  let system: string | undefined;
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = contentToString(msg.content);
      system = system ? system + '\n' + text : text;
      continue;
    }

    if (msg.role === 'tool') {
      // Tool result → user turn with tool_result block
      result.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id ?? '',
            content: contentToString(msg.content),
          },
        ],
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      // Assistant tool calls → assistant turn with tool_use blocks
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content) {
        blocks.push({ type: 'text', text: contentToString(msg.content) });
      }
      for (const tc of msg.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeParseJSON(tc.function.arguments),
        });
      }
      result.push({ role: 'assistant', content: blocks });
      continue;
    }

    // Regular user/assistant message
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const text = contentToString(msg.content);
    result.push({ role, content: text });
  }

  return { system, messages: result };
}

// Server tool names that map to native Anthropic tools — excluded from function tools
const ANTHROPIC_SERVER_TOOL_NAMES = new Set(['web_search', 'code_execution', 'web_fetch']);

function toAnthropicTools(tools: OpenAITool[] | undefined): Anthropic.ToolUnion[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const result: Anthropic.ToolUnion[] = [];

  // Regular function tools (exclude server tools)
  const functionTools = tools
    .filter((t) => t.type === 'function' && t.function && !ANTHROPIC_SERVER_TOOL_NAMES.has(t.function.name))
    .map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: (t.function.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool['input_schema'],
    }));
  result.push(...functionTools);

  // Native Anthropic server tools — translated from OpenAI tool names
  const names = tools.map((t) => t.function?.name);
  if (names.includes('web_search')) {
    result.push({ type: 'web_search_20260209', name: 'web_search' } as Anthropic.WebSearchTool20260209);
  }
  if (names.includes('code_execution')) {
    result.push({ type: 'code_execution_20250825', name: 'code_execution' } as Anthropic.CodeExecutionTool20250825);
  }
  if (names.includes('web_fetch')) {
    result.push({ type: 'web_fetch_20250910', name: 'web_fetch' } as Anthropic.WebFetchTool20250910);
  }

  return result.length > 0 ? result : undefined;
}

function toAnthropicToolChoice(
  choice: OpenAIToolChoice | undefined,
): Anthropic.ToolChoice | undefined {
  if (!choice || choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (typeof choice === 'object' && choice.type === 'function') {
    return { type: 'tool', name: choice.function.name };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Anthropic → OpenAI translation
// ---------------------------------------------------------------------------

function makeUsage(usage: Anthropic.Usage | undefined): OpenAIUsage {
  return {
    prompt_tokens: usage?.input_tokens ?? 0,
    completion_tokens: usage?.output_tokens ?? 0,
    total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
  };
}

function mapFinishReason(stopReason: string | null | undefined): OpenAIResponse['choices'][0]['finish_reason'] {
  if (stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'max_tokens') return 'length';
  return 'stop';
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

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements ProviderAdapter {
  async handleCompletion(openaiReq: OpenAIRequest, res: ServerResponse): Promise<void> {
    const modelName = openaiReq.model ?? 'claude-sonnet-4-5';
    const { system, messages } = toAnthropicMessages(openaiReq.messages);
    const tools = toAnthropicTools(openaiReq.tools);

    const hasTools = (tools?.length ?? 0) > 0;
    console.log(
      `[anthropic-adapter] model=${modelName} messages=${openaiReq.messages.length}` +
        ` hasTools=${hasTools} stream=${openaiReq.stream ?? false}`,
    );

    // Build base request params
    const toolChoice = toAnthropicToolChoice(openaiReq.tool_choice);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: modelName,
      max_tokens: openaiReq.max_tokens ?? 8192,
      messages: messages as Anthropic.MessageParam[],
    };
    if (system) params.system = system;
    if (tools) params.tools = tools;
    if (tools && toolChoice) params.tool_choice = toolChoice;
    if (openaiReq.temperature !== undefined) params.temperature = openaiReq.temperature;
    if (openaiReq.top_p !== undefined) params.top_p = openaiReq.top_p;

    if (openaiReq.stream) {
      await this.handleStream(params, modelName, res);
    } else {
      await this.handleNonStream(params, modelName, res);
    }
  }

  private async handleNonStream(
    params: Anthropic.MessageCreateParamsNonStreaming,
    modelName: string,
    res: ServerResponse,
  ): Promise<void> {
    const message = await client.messages.create(params);

    const textBlocks = message.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const toolUseBlocks = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

    const text = textBlocks.map((b) => b.text).join('');
    const idSuffix = String(Date.now());

    const toolCalls: OpenAIToolCall[] = toolUseBlocks.map((b, i) => ({
      id: b.id ?? `call_${idSuffix}_${i}`,
      type: 'function',
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));

    const responseMessage: OpenAIResponse['choices'][0]['message'] = {
      role: 'assistant',
      content: text || null,
    };
    if (toolCalls.length > 0) responseMessage.tool_calls = toolCalls;

    const response: OpenAIResponse = {
      id: `chatcmpl-${message.id ?? idSuffix}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          message: responseMessage,
          finish_reason: mapFinishReason(message.stop_reason),
        },
      ],
      usage: makeUsage(message.usage),
    };

    console.log(
      `[anthropic-adapter] non-stream done model=${modelName}` +
        ` textLen=${text.length} toolCalls=${toolCalls.length} stopReason=${message.stop_reason}`,
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private async handleStream(
    params: Anthropic.MessageCreateParamsNonStreaming,
    modelName: string,
    res: ServerResponse,
  ): Promise<void> {
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

    // Track streaming state
    let totalChars = 0;
    let toolCallIndex = 0;
    let stopReason: string | null = null;
    // Map content block index → tool call index (for input_json_delta routing)
    const blockIndexToToolIndex = new Map<number, number>();
    let inputUsage = 0;
    let outputUsage = 0;

    const streamParams = { ...params, stream: true } as Anthropic.MessageCreateParamsStreaming;

    const stream = await client.messages.create(streamParams);

    for await (const event of stream) {
      if (event.type === 'message_start') {
        inputUsage = event.message?.usage?.input_tokens ?? 0;
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'text') {
          // Nothing to emit yet — text comes in content_block_delta
        } else if (block.type === 'tool_use') {
          // Register this content block index → tool call slot
          blockIndexToToolIndex.set(event.index, toolCallIndex);
          // Emit tool call header delta
          res.write(
            `data: ${JSON.stringify(
              makeStreamChunk(id, modelName, {
                tool_calls: [
                  {
                    index: toolCallIndex,
                    id: block.id,
                    type: 'function',
                    function: { name: block.name, arguments: '' },
                  },
                ],
              }),
            )}\n\n`,
          );
          toolCallIndex++;
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          totalChars += delta.text.length;
          res.write(
            `data: ${JSON.stringify(makeStreamChunk(id, modelName, { content: delta.text }))}\n\n`,
          );
        } else if (delta.type === 'input_json_delta') {
          const tcIdx = blockIndexToToolIndex.get(event.index);
          if (tcIdx !== undefined) {
            res.write(
              `data: ${JSON.stringify(
                makeStreamChunk(id, modelName, {
                  tool_calls: [
                    {
                      index: tcIdx,
                      function: { arguments: delta.partial_json },
                    },
                  ],
                }),
              )}\n\n`,
            );
          }
        }
      } else if (event.type === 'message_delta') {
        stopReason = event.delta?.stop_reason ?? null;
        outputUsage = event.usage?.output_tokens ?? 0;
      }
    }

    const finalFinishReason = stopReason === 'tool_use' ? 'tool_calls' : 'stop';
    res.write(
      `data: ${JSON.stringify(makeStreamChunk(id, modelName, {}, finalFinishReason))}\n\n`,
    );

    // Usage chunk (empty choices[], usage populated — OpenAI streaming convention)
    const usage: OpenAIUsage = {
      prompt_tokens: inputUsage,
      completion_tokens: outputUsage,
      total_tokens: inputUsage + outputUsage,
    };
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
      `[anthropic-adapter] stream done model=${modelName} totalChars=${totalChars}` +
        ` toolCalls=${toolCallIndex} stopReason=${stopReason} usage=${JSON.stringify(usage)}`,
    );
  }
}
