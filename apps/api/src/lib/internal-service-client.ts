// No fallback: apps/api's Lambda cannot reach mcp-server (127.0.0.1:3002) without
// violating mcp-server's no-new-network-exposure constraint, so the Gmail proxy
// ships disabled this release. Callers (getRemoteTools in routes/mcp.ts) must
// treat an unset MCP_SERVER_URL as "explicitly disabled," not "misconfigured."
const MCP_SERVER_URL = process.env.MCP_SERVER_URL;

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
    // Fail fast on a misconfigured or unreachable URL rather than stalling until
    // the Lambda's own timeout (29s for FoundationApiFunction).
    signal: AbortSignal.timeout(2000),
  });
}
