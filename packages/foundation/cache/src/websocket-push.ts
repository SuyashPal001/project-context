import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getCacheClient } from './client';

let apiGatewayClient: ApiGatewayManagementApiClient | undefined;
let wsApiEndpoint: string | undefined;

async function getWsApiEndpoint(): Promise<string> {
  if (wsApiEndpoint) {
    return wsApiEndpoint;
  }

  const project = process.env.PROJECT ?? 'project-context';
  const env = process.env.ENVIRONMENT ?? 'dev';
  const endpointParamName = `/${project}/${env}/api-gateway/ws-api-endpoint`;
  const ssm = new SSMClient({});
  try {
    const command = new GetParameterCommand({
      Name: endpointParamName,
      WithDecryption: false,
    });
    const output = await ssm.send(command);
    const endpoint = output.Parameter?.Value;
    if (!endpoint) {
      throw new Error(`SSM parameter is empty: ${endpointParamName}`);
    }
    wsApiEndpoint = endpoint.replace('wss://', 'https://');
    return wsApiEndpoint;
  } catch (error) {
    console.error('Failed to fetch WebSocket API endpoint from SSM:', error);
    throw new Error('Could not load WebSocket API endpoint.');
  }
}

async function getApiGatewayClient(): Promise<ApiGatewayManagementApiClient> {
  if (apiGatewayClient) {
    return apiGatewayClient;
  }
  const endpoint = await getWsApiEndpoint();
  apiGatewayClient = new ApiGatewayManagementApiClient({
    endpoint,
  });
  return apiGatewayClient;
}

export async function pushToConnection(
  connectionId: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    const client = await getApiGatewayClient();
    const command = new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify(payload),
    });
    await client.send(command);
    return true;
  } catch (error) {
    if (error instanceof GoneException) {
      console.log(`Stale connection found: ${connectionId}`);
      return false;
    }
    console.error(`Failed to push to connection ${connectionId}:`, error);
    return false;
  }
}

export async function pushToConnectedClients(
  tenantId: string,
  userId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const redisKey = `ws:tenant:${tenantId}:user:${userId}`;
  const cache = getCacheClient();

  try {
    const connectionIds = await cache.smembers(redisKey);
    if (connectionIds.length === 0) {
      return;
    }

    console.log(`Pushing to ${connectionIds.length} clients for user ${userId}`);

    const pushPromises = connectionIds.map(async (connectionId) => {
      const success = await pushToConnection(connectionId, payload);
      if (!success) {
        console.log(`Removing stale connection ${connectionId} from ${redisKey}`);
        await cache.srem(redisKey, connectionId);
      }
    });

    await Promise.all(pushPromises);
  } catch (error) {
    console.error(`Failed to push to clients for user ${userId}:`, error);
  }
}