import express from 'express';
import { handleMcpRequest } from './server';
import { isAuthorizedCaller } from './auth/service-auth';

const PORT = 3002;
const HOST = process.env.MCP_BIND_HOST ?? '127.0.0.1';
const app = express();

// Refuse to start without a service key rather than run unauthenticated.
// A process that exits on deploy is discoverable; one that silently accepts
// anonymous callers to a tenant's mailbox is not.
if (!process.env.INTERNAL_SERVICE_KEY) {
  console.error(
    '[mcp-server] INTERNAL_SERVICE_KEY is not set. This service resolves tenant ' +
      'Google credentials and will not start unauthenticated.',
  );
  process.exit(1);
}

app.use(express.json());

// ── MCP endpoint ──────────────────────────────────────────────────────────────
// All MCP JSON-RPC messages (tools/list, tools/call) come through here.
//
// Authentication is mandatory: x-tenant-id names whose Gmail credentials get
// decrypted, so it is only meaningful once the caller has proven it is platform
// infrastructure. x-agent-id is required by the policy guard at call time.
app.post('/mcp', async (req, res) => {
  if (!isAuthorizedCaller(req.header('x-internal-service-key'))) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
    return;
  }

  try {
    await handleMcpRequest(req, res);
  } catch (err) {
    console.error('[mcp] unhandled error:', (err as Error).message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mcp-server', port: PORT });
});

// Bind loopback by default. Only callers on the VM need this service; exposing
// it on 0.0.0.0 puts tenant mailbox access one firewall rule away from the
// internet. Override with MCP_BIND_HOST if a real remote caller is introduced.
app.listen(PORT, HOST, () => {
  console.log(`[mcp-server] listening on ${HOST}:${PORT}`);
});
