import type { APIGatewayProxyResult } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { jwtVerify } from 'jose';
import { getCacheClient, pushToConnection } from '@serverless-saas/cache';

// Module-level cache for the SSM parameter
let wsTokenSecret: Uint8Array | undefined;

async function getWsTokenSecret(): Promise<Uint8Array> {
    if (wsTokenSecret) {
        return wsTokenSecret;
    }

    const env = process.env.ENVIRONMENT ?? 'dev';
    const secretName = `/project-context/${env}/ws-token-secret`;
    const ssm = new SSMClient({});

    try {
        const command = new GetParameterCommand({
            Name: secretName,
            WithDecryption: true,
        });
        const output = await ssm.send(command);

        const secretValue = output.Parameter?.Value;
        if (!secretValue) {
            throw new Error('SSM parameter value for ws-token-secret is empty.');
        }

        wsTokenSecret = new TextEncoder().encode(secretValue);
        return wsTokenSecret;
    } catch (error) {
        console.error('Failed to fetch ws-token-secret from SSM:', error);
        throw new Error('Could not load WebSocket token secret.');
    }
}

export const handler = async (event: any): Promise<APIGatewayProxyResult> => {
    const routeKey = event.requestContext.routeKey;
    const connectionId = event.requestContext.connectionId;

    console.log('WebSocket event:', { routeKey, connectionId });

    try {
        switch (routeKey) {
            case '$connect':
                return await handleConnect(event, connectionId);

            case '$disconnect':
                return await handleDisconnect(connectionId);

            case '$default':
                return await handleDefault(event, connectionId);

            default:
                console.log('Unknown route key:', routeKey);
                return { statusCode: 400, body: 'Unknown route' };
        }
    } catch (error) {
        console.error('Unhandled error in WebSocket handler:', error);
        return { statusCode: 500, body: 'Internal server error' };
    }
};

async function handleConnect(event: any, connectionId: string): Promise<APIGatewayProxyResult> {
    try {
        const token = event.queryStringParameters?.token;
        if (!token) {
            console.log('Connect failed: Missing token');
            return { statusCode: 401, body: 'Unauthorized' };
        }

        const secret = await getWsTokenSecret();
        const { payload } = await jwtVerify(token, secret);

        const { userId, tenantId } = payload as { userId?: string, tenantId?: string };

        if (!userId || !tenantId) {
            console.log('Connect failed: Invalid token payload', payload);
            return { statusCode: 401, body: 'Unauthorized' };
        }

        const cache = getCacheClient();
        const member = `${userId}:${connectionId}`;

        // Flat tenant-level SET — used by pushWebSocketEvent (no SCAN needed)
        await cache.sadd(`ws:tenant:${tenantId}:connections`, member);
        await cache.expire(`ws:tenant:${tenantId}:connections`, 86400);

        // Reverse lookup — used by disconnect to find the right SET without SCAN
        await cache.set(`ws:connection:${connectionId}`, `${tenantId}:${userId}`, { ex: 86400 });

        console.log('Client connected and authenticated:', { userId, tenantId, connectionId });
        return { statusCode: 200, body: 'Connected.' };

    } catch (error: any) {
        if (error.code === 'ERR_JWS_INVALID' || error.code === 'ERR_JWT_EXPIRED') {
            console.log('Connect failed: Invalid or expired token', { error: error.message });
        } else {
            console.error('Connect handler error:', error);
        }
        return { statusCode: 401, body: 'Unauthorized' };
    }
}

async function handleDisconnect(connectionId: string): Promise<APIGatewayProxyResult> {
    try {
        const cache = getCacheClient();

        // Reverse lookup to find tenantId + userId directly — no SCAN
        const lookup = await cache.get(`ws:connection:${connectionId}`) as string | null;
        if (lookup) {
            const colonIdx = lookup.indexOf(':');
            const tenantId = lookup.slice(0, colonIdx);
            const userId = lookup.slice(colonIdx + 1);
            const member = `${userId}:${connectionId}`;

            await cache.srem(`ws:tenant:${tenantId}:connections`, member);
            await cache.del(`ws:connection:${connectionId}`);
            console.log('Client disconnected and removed:', { connectionId, tenantId });
        } else {
            console.log('Client disconnected, not found in reverse lookup:', { connectionId });
        }

    } catch (error) {
        console.error('Disconnect handler error:', error);
    }

    return { statusCode: 200, body: 'Disconnected.' };
}

async function handleDefault(event: any, connectionId: string): Promise<APIGatewayProxyResult> {
    try {
        if (event.body) {
            const body = JSON.parse(event.body);
            if (body.action === 'ping') {
                await pushToConnection(connectionId, { type: 'pong' });
                return { statusCode: 200, body: 'pong' };
            }
        }
        console.log('Received default message:', event.body);
    } catch (error) {
        console.error('Default handler error:', error);
    }

    return { statusCode: 200, body: 'OK' };
}