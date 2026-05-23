import { getCacheClient, pushToConnection } from '@serverless-saas/cache';

export async function pushWebSocketEvent(
  tenantId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const cache = getCacheClient();
  const setKey = `ws:tenant:${tenantId}:connections`;

  // Single SMEMBERS on the flat tenant SET — no SCAN
  const members = await cache.smembers(setKey) as string[];

  await Promise.all(
    members.map(async (member) => {
      const connectionId = member.slice(member.indexOf(':') + 1);
      const ok = await pushToConnection(connectionId, payload);
      if (!ok) await cache.srem(setKey, member);
    })
  );
}
