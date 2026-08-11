import { Hono } from 'hono';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { getMcpRegistry } from '@serverless-saas/mcp';
import { registerAgentPlatformMcpTools } from '@serverless-saas/agent-capabilities';
import { getLogger } from '@serverless-saas/logger';
import type { AppEnv } from '../types';
import { callMcpServer } from '../lib/internal-service-client';

registerAgentPlatformMcpTools();

const logger = getLogger({ serviceName: 'api' });

interface RemoteToolListEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const remoteToolsCache = new Map<string, { tools: RemoteToolListEntry[]; expiresAt: number }>();
const REMOTE_TOOLS_TTL_MS = 60_000;

// True for every LOCAL tool registered today (start_task/get_task_thread both take
// only {taskId}: a single required string property). Kept as a deliberate
// simplification for the local-registry loop only — it is NOT reused for remote
// (mcp-server) tools below, whose schemas include real optional/typed properties
// (see toZodRawShapeFromJsonSchema).
function toZodRawShape(properties: Record<string, unknown>): z.ZodRawShape {
  return Object.fromEntries(Object.keys(properties).map((k) => [k, z.string()]));
}

// Converts a flat JSON-Schema object (as returned by mcp-server's tools/list —
// `{ type: 'object', properties: { <name>: { type: 'string'|'number'|'integer'|'boolean', ... } }, required: string[] }`)
// into a Zod raw shape, honoring each property's declared type and whether it's in
// the schema's `required` array. Properties not in `required` become `.optional()`.
// Limits: only handles the flat top-level property types mcp-server's tools
// actually use (string/number/integer/boolean); an unrecognized or missing `type`
// falls back to `z.unknown()` rather than guessing. Does not handle nested
// objects/arrays, enums, or other JSON-Schema keywords (format, min/max, etc.) —
// none of the tools registered today need them.
function toZodRawShapeFromJsonSchema(schema: Record<string, unknown>): z.ZodRawShape {
  const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = new Set((schema.required as string[] | undefined) ?? []);
  return Object.fromEntries(
    Object.entries(properties).map(([key, propSchema]) => {
      const type = propSchema?.type;
      let zodType: z.ZodTypeAny;
      switch (type) {
        case 'string':
          zodType = z.string();
          break;
        case 'number':
        case 'integer':
          zodType = z.number();
          break;
        case 'boolean':
          zodType = z.boolean();
          break;
        default:
          zodType = z.unknown();
      }
      return [key, required.has(key) ? zodType : zodType.optional()];
    }),
  );
}

// mcp-server's StreamableHTTPServerTransport is constructed with no
// `enableJsonResponse` (defaults false), so its responses are SSE-framed even
// for a single request/response exchange:
//   event: message
//   data: {"jsonrpc":"2.0","id":1,"result":{...}}
// (each event terminated by a blank line). Plain `res.json()` throws a
// SyntaxError against that body. This reads the full text, pulls out every
// `data: ` line, and JSON-parses the last one (the final result for this
// single-response transport usage — earlier `data:` lines, if any, would be
// intermediate/progress events we don't need here).
async function parseSseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const dataLines = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  if (dataLines.length === 0) {
    throw new Error(`No SSE data payload in mcp-server response: ${text.slice(0, 200)}`);
  }
  return JSON.parse(dataLines[dataLines.length - 1]) as T;
}

async function getRemoteTools(tenantId: string): Promise<RemoteToolListEntry[]> {
  if (!process.env.MCP_SERVER_URL) {
    // Explicitly disabled this release — apps/api's Lambda cannot reach
    // mcp-server without violating its no-new-network-exposure constraint.
    // This is distinct from "attempted and failed": no fetch is made.
    logger.info('Remote MCP tools (Gmail proxy) disabled: MCP_SERVER_URL is unset', { tenantId });
    return [];
  }
  const cached = remoteToolsCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.tools;
  try {
    const res = await callMcpServer('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { tenantId });
    if (!res.ok) {
      logger.error('mcp-server tools/list returned non-OK status', { tenantId, status: res.status });
      remoteToolsCache.set(tenantId, { tools: [], expiresAt: Date.now() + REMOTE_TOOLS_TTL_MS });
      return [];
    }
    const body = await parseSseJsonResponse<{ result?: { tools?: RemoteToolListEntry[] } }>(res);
    const tools = body.result?.tools ?? [];
    remoteToolsCache.set(tenantId, { tools, expiresAt: Date.now() + REMOTE_TOOLS_TTL_MS });
    return tools;
  } catch (err) {
    logger.error('Failed to fetch remote tools from mcp-server', { tenantId, error: err instanceof Error ? err : undefined });
    remoteToolsCache.set(tenantId, { tools: [], expiresAt: Date.now() + REMOTE_TOOLS_TTL_MS });
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
    try {
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
    } catch (err) {
      // registerTool throws on a duplicate name; skip the offending tool rather
      // than crashing the whole /mcp request.
      logger.error('Failed to register local MCP tool', { tenantId: apiKeyContext.tenantId, toolName: definition.name, error: err instanceof Error ? err : undefined });
    }
  }

  const remoteTools = await getRemoteTools(apiKeyContext.tenantId);
  for (const remoteTool of remoteTools) {
    if (localToolNames.has(remoteTool.name)) continue;
    try {
      // Same cast rationale as the local-tool loop above: the shape's keys come from
      // mcp-server's response at runtime, not a literal, which otherwise sends TS's
      // inference into "excessively deep" territory.
      (server.registerTool as (name: string, config: unknown, cb: unknown) => unknown)(
        remoteTool.name,
        { title: remoteTool.name, description: remoteTool.description, inputSchema: toZodRawShapeFromJsonSchema(remoteTool.inputSchema) },
        async (args: Record<string, unknown>) => {
          try {
            const res = await callMcpServer(
              '/mcp',
              { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: remoteTool.name, arguments: args } },
              { tenantId: apiKeyContext.tenantId, agentId },
            );
            if (!res.ok) return { content: [{ type: 'text' as const, text: `Upstream error: ${res.status}` }], isError: true };
            const body = await parseSseJsonResponse<{ result?: unknown }>(res);
            return body.result as { content: { type: 'text'; text: string }[]; isError?: boolean };
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            return { content: [{ type: 'text' as const, text: `Proxy failed: ${message}` }], isError: true };
          }
        },
      );
    } catch (err) {
      // registerTool throws on a duplicate name (e.g. mcp-server returning a
      // repeated tool); skip this tool and log rather than crashing the request.
      logger.error('Failed to register remote MCP tool', { tenantId: apiKeyContext.tenantId, toolName: remoteTool.name, error: err instanceof Error ? err : undefined });
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport();
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
