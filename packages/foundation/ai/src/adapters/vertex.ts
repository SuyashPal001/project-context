import { generateText, type ModelMessage, type ToolModelMessage } from 'ai';
import { createVertex } from '@ai-sdk/google-vertex';
import type { AgentRuntime } from '../runtime/interface';
import type { AgentRunRequest, AgentRunResponse, AgentMessage } from '../runtime/types';
import { getGcpCredentials } from '../gcp-credentials';

const DEFAULT_MODEL = 'gemini-2.0-flash';
const DEFAULT_LOCATION = 'us-central1';

/**
 * Build a Vertex AI provider instance.
 * Reads credentials via getGcpCredentials() (cached after first call).
 * Falls back to Application Default Credentials when no SA key is configured.
 */
async function buildProvider() {
    // ADC fallback when no SA key source is configured at all
    if (!process.env.GCP_SA_KEY_SECRET_ARN && !process.env.GCP_SA_KEY) {
        return createVertex({
            project: process.env.GCP_PROJECT_ID,
            location: process.env.GCP_LOCATION ?? DEFAULT_LOCATION,
        });
    }

    const credentials = await getGcpCredentials();
    return createVertex({
        project: credentials.project_id,
        location: process.env.GCP_LOCATION ?? DEFAULT_LOCATION,
        googleAuthOptions: { credentials },
    });
}

/**
 * Map AgentMessage[] to AI SDK ModelMessage[].
 * System messages are extracted separately and passed as the `system` param.
 * Tool result messages require toolName in the AI SDK — we default to '' since
 * our ToolResult type does not carry toolName (it's an orchestration-layer concern).
 */
function toCoreMesages(messages: AgentMessage[]): ModelMessage[] {
    return messages
        .filter((m) => m.role !== 'system')
        .map((m): ModelMessage => {
            // Assistant message with tool calls
            if (m.role === 'assistant' && m.toolCalls?.length) {
                return {
                    role: 'assistant',
                    content: [
                        ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
                        ...m.toolCalls.map((tc) => ({
                            type: 'tool-call' as const,
                            toolCallId: tc.id,
                            toolName: tc.name,
                            input: tc.arguments,
                        })),
                    ],
                };
            }

            // Tool result message
            if (m.role === 'tool' && m.toolResults?.length) {
                const toolMessage: ToolModelMessage = {
                    role: 'tool',
                    content: m.toolResults.map((tr) => ({
                        type: 'tool-result' as const,
                        toolCallId: tr.toolCallId,
                        toolName: '', // ToolResult type doesn't carry toolName — relay fills this
                        output: tr.error
                            ? { type: 'error-json' as const, value: tr.error as any }
                            : { type: 'json' as const, value: tr.result as any },
                    })),
                };
                return toolMessage;
            }

            // Plain user or assistant message
            return {
                role: m.role as 'user' | 'assistant',
                content: m.content,
            };
        });
}

/**
 * Map AI SDK finishReason to our union.
 * AI SDK uses 'tool-calls' (hyphen); our type uses 'tool_calls' (underscore).
 */
function mapFinishReason(reason: string): AgentRunResponse['finishReason'] {
    switch (reason) {
        case 'stop': return 'stop';
        case 'length': return 'length';
        case 'tool-calls': return 'tool_calls';
        default: return 'error';
    }
}

export class VertexAdapter implements AgentRuntime {
    getName(): string {
        return 'vertex';
    }

    async isAvailable(): Promise<boolean> {
        return !!(process.env.GCP_SA_KEY_SECRET_ARN || process.env.GCP_SA_KEY || process.env.GCP_PROJECT_ID);
    }

    async run(request: AgentRunRequest): Promise<AgentRunResponse> {
        const { skill, policy, messages } = request;

        const vertex = await buildProvider();
        const modelId = (skill.config.model as string | undefined) ?? DEFAULT_MODEL;

        // Merge skill systemPrompt with any explicit system messages in the thread
        const systemMessages = messages.filter((m) => m.role === 'system');
        const system = [
            skill.systemPrompt,
            ...systemMessages.map((m) => m.content),
        ].join('\n\n');

        const coreMessages = toCoreMesages(messages);

        const result = await generateText({
            model: vertex(modelId),
            system,
            messages: coreMessages,
            temperature: skill.config.temperature,
            maxOutputTokens: policy.maxTokensPerMessage ?? skill.config.maxTokens,
            topP: skill.config.topP,
        });

        const toolCalls = result.toolCalls?.map((tc) => ({
            id: tc.toolCallId,
            name: tc.toolName,
            arguments: tc.input as Record<string, unknown>,
        }));

        return {
            message: {
                role: 'assistant',
                content: result.text,
                toolCalls: toolCalls?.length ? toolCalls : undefined,
            },
            tokenCount: {
                input: result.usage.inputTokens ?? 0,
                output: result.usage.outputTokens ?? 0,
                total: result.usage.totalTokens ?? 0,
            },
            model: modelId,
            finishReason: mapFinishReason(result.finishReason),
        };
    }
}

export const vertexAdapter = new VertexAdapter();
