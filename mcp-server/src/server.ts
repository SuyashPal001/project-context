import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { registerGmailTools } from './tools/gmail';

/**
 * Handles a single MCP request in a stateless manner.
 *
 * A new McpServer + transport is created per request — this is intentional
 * for multi-tenancy: each request gets its own tool registry scoped to
 * the tenant/agent context extracted from headers.
 */
export async function handleMcpRequest(
  req: Request,
  res: Response
): Promise<void> {
  const tenantId = req.headers['x-tenant-id'] as string | undefined;
  const agentId = req.headers['x-agent-id'] as string | undefined;
  const sessionId = req.headers['x-session-id'] as string | undefined;

  if (!tenantId) {
    res.status(400).json({ error: 'x-tenant-id header is required' });
    return;
  }

  const server = new McpServer({
    name: 'platform-mcp-server',
    version: '1.0.0',
  });

  // Register tools with tenant/agent/session context captured in closure.
  // sessionId is optional — absent for non-interactive callers (e.g. scheduled
  // workflow runs with no live chat session); the policy guard fails closed
  // for those rather than routing an approval request nobody can answer.
  registerGmailTools(server, { tenantId, agentId, sessionId });

  // Stateless transport — no session persistence between requests
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } finally {
    // Clean up after response is sent
    res.on('finish', () => {
      server.close().catch(() => undefined);
    });
  }
}
