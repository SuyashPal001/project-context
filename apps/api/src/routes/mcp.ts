import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { getMcpRegistry } from '@serverless-saas/mcp';
import { registerAgentPlatformMcpTools } from '@serverless-saas/agent-capabilities';
import type { AppEnv } from '../types';
import { callMcpServer } from '../lib/internal-service-client';

registerAgentPlatformMcpTools();

interface RemoteToolListEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

let remoteToolsCache: { tools: RemoteToolListEntry[]; expiresAt: number } | null = null;
const REMOTE_TOOLS_TTL_MS = 60_000;

// Assumes every registry property is type: 'string' — true for all tools registered
// today (start_task/get_task_thread both take only {taskId}). A future non-string
// tool parameter needs a real McpPropertySchema→Zod converter here, not this
// simplification. Shared by both the local registry loop and the remote (mcp-server)
// tool loop below, since mcp-server's /mcp tools/list also returns a JSON-Schema-like
// inputSchema rather than a Zod shape.
function toZodRawShape(properties: Record<string, unknown>): z.ZodRawShape {
  return Object.fromEntries(Object.keys(properties).map((k) => [k, z.string()]));
}

async function getRemoteTools(tenantId: string): Promise<RemoteToolListEntry[]> {
  if (remoteToolsCache && remoteToolsCache.expiresAt > Date.now()) return remoteToolsCache.tools;
  try {
    const res = await callMcpServer('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { tenantId });
    if (!res.ok) return [];
    const body = await res.json() as { result?: { tools?: RemoteToolListEntry[] } };
    const tools = body.result?.tools ?? [];
    remoteToolsCache = { tools, expiresAt: Date.now() + REMOTE_TOOLS_TTL_MS };
    return tools;
  } catch {
    return [];
  }
}

export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.post('/', async (c) => {
  const apiKeyContext = c.get('apiKeyContext');
  if (!apiKeyContext) {
    return c.json({ error: 'This endpoint requires agent API key authentication', code: 'MCP_AUTH_REQUIRED' }, 401);
  }
  const agentId = c.get('agentId');
  const localRegistry = getMcpRegistry();
  const localToolNames = new Set(localRegistry.getDefinitions().map((d) => d.name));

  const server = new McpServer({ name: 'project-context-mcp', version: '1.0.0' });

  for (const definition of localRegistry.getDefinitions()) {
    // Cast to bypass TS's attempt to statically infer a Zod arg type from a
    // runtime-computed property-key set (toZodRawShape's shape is built from a
    // loop variable, not a literal) — that inference is what triggers "Type
    // instantiation is excessively deep and possibly infinite" here. The
    // handler already treats args as Record<string, unknown>, so no type
    // safety is actually lost by widening the registerTool call itself.
    (server.registerTool as (name: string, config: unknown, cb: unknown) => unknown)(
      definition.name,
      {
        title: definition.name,
        description: definition.description,
        inputSchema: toZodRawShape(definition.inputSchema.properties),
      },
      async (args: Record<string, unknown>) => {
        const result = await localRegistry.execute(
          { name: definition.name, arguments: args },
          { tenantId: apiKeyContext.tenantId, keyId: apiKeyContext.keyId, keyType: apiKeyContext.type as 'mcp' | 'agent' | 'rest' | 'oauth', permissions: apiKeyContext.permissions, agentId },
        );
        return result;
      },
    );
  }

  const remoteTools = await getRemoteTools(apiKeyContext.tenantId);
  for (const remoteTool of remoteTools) {
    if (localToolNames.has(remoteTool.name)) continue;
    const remoteProperties = (remoteTool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    // Same cast rationale as the local-tool loop above: the shape's keys come from
    // mcp-server's response at runtime, not a literal, which otherwise sends TS's
    // inference into "excessively deep" territory.
    (server.registerTool as (name: string, config: unknown, cb: unknown) => unknown)(
      remoteTool.name,
      { title: remoteTool.name, description: remoteTool.description, inputSchema: toZodRawShape(remoteProperties) },
      async (args: Record<string, unknown>) => {
        try {
          const res = await callMcpServer(
            '/mcp',
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: remoteTool.name, arguments: args } },
            { tenantId: apiKeyContext.tenantId, agentId },
          );
          if (!res.ok) return { content: [{ type: 'text' as const, text: `Upstream error: ${res.status}` }], isError: true };
          const body = await res.json() as { result?: unknown };
          return body.result as { content: { type: 'text'; text: string }[]; isError?: boolean };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          return { content: [{ type: 'text' as const, text: `Proxy failed: ${message}` }], isError: true };
        }
      },
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
