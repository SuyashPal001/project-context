const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? 'http://127.0.0.1:3002';

export interface McpServerCallOptions {
  tenantId: string;
  agentId?: string;
}

export async function callMcpServer(
  path: string,
  body: unknown,
  options: McpServerCallOptions,
): Promise<Response> {
  return fetch(`${MCP_SERVER_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // mcp-server's StreamableHTTPServerTransport POST handler rejects requests
      // with a 406 unless Accept includes BOTH of these — it does not accept a
      // plain application/json-only Accept header.
      Accept: 'application/json, text/event-stream',
      'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '',
      'x-tenant-id': options.tenantId,
      ...(options.agentId ? { 'x-agent-id': options.agentId } : {}),
    },
    body: JSON.stringify(body),
  });
}
