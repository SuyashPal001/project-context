import { Hono } from 'hono';
import { getMcpRegistry } from '@serverless-saas/mcp';
import type { AppEnv } from '@serverless-saas/types';

export const mcpRoutes = new Hono<AppEnv>();

// POST /mcp/tools/call
mcpRoutes.post('/tools/call', async (c) => {
  const apiKeyContext = c.get('apiKeyContext');
  if (!apiKeyContext) {
    return c.json({ error: 'This endpoint requires agent API key authentication', code: 'MCP_AUTH_REQUIRED' }, 401);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.name !== 'string') {
    return c.json({ error: 'name is required' }, 400);
  }

  const result = await getMcpRegistry().execute(
    { name: body.name, arguments: body.arguments ?? {} },
    {
      tenantId: apiKeyContext.tenantId,
      keyId: apiKeyContext.keyId,
      keyType: apiKeyContext.type as 'mcp' | 'agent' | 'rest' | 'oauth',
      permissions: apiKeyContext.permissions,
    },
  );

  return c.json(result);
});

// GET /mcp/tools — list available tool definitions
mcpRoutes.get('/tools', async (c) => {
  const apiKeyContext = c.get('apiKeyContext');
  if (!apiKeyContext) {
    return c.json({ error: 'This endpoint requires agent API key authentication', code: 'MCP_AUTH_REQUIRED' }, 401);
  }

  return c.json({ data: getMcpRegistry().getDefinitions() });
});
