// Local dev server — same app, different entry point
// Production uses index.ts (Lambda handler)
// Local uses this file (Node HTTP server)

// GCP VM has no IPv6 routing to AWS — force IPv4 so Node.js 22's Happy Eyeballs
// doesn't time out on the IPv6 addresses Neon resolves to.
import { setDefaultResultOrder } from 'dns';
setDefaultResultOrder('ipv4first');

import { serve } from '@hono/node-server';
import { app } from './app';

const port = Number(process.env.PORT) || 3001;

serve({ fetch: app.fetch, port }, () => {
  console.log(`Foundation API running at http://localhost:${port}`);
});
