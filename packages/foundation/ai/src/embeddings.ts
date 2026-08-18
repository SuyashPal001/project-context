import { GoogleAuth } from 'google-auth-library';
import * as crypto from 'crypto';
import { getGcpCredentials } from './gcp-credentials';
import { fetchWithRetry } from './utils/retry';

const EMBEDDING_MODEL = 'text-embedding-004';
const EMBEDDING_DIMENSIONS = 768;
const BATCH_SIZE = 100;

export type TaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface EmbeddingResult {
  contentHash: string;   // sha256 of the input text
  embedding: number[];
}

async function embedTextsViaGateway(
  texts: string[],
  taskType: TaskType,
  gatewayUrl: string,
  serviceKey: string,
): Promise<EmbeddingResult[]> {
  const url = `${gatewayUrl}/v1/embeddings`;
  const results: EmbeddingResult[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-key': serviceKey,
        'x-task-type': taskType,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Inference gateway embedding failed: ${err}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    for (let j = 0; j < batch.length; j++) {
      results.push({
        contentHash: crypto.createHash('sha256').update(batch[j]).digest('hex'),
        embedding: sorted[j].embedding,
      });
    }
  }

  return results;
}

export async function embedTexts(
  texts: string[],
  taskType: TaskType
): Promise<EmbeddingResult[]> {
  // Prefer routing through the inference gateway — it has ADC access to Vertex AI
  // and uses the same text-embedding-004 (768d) model as the stored document chunks.
  const gatewayUrl = process.env.INFERENCE_GATEWAY_URL;
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (gatewayUrl && serviceKey) {
    return embedTextsViaGateway(texts, taskType, gatewayUrl, serviceKey);
  }

  const credentials = await getGcpCredentials();
  const project = credentials.project_id;
  const location = process.env.GCP_LOCATION ?? 'us-central1';
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  // Build auth client once — GoogleAuth handles token caching internally
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const authClient = await auth.getClient();

  const results: EmbeddingResult[] = [];

  // Process in batches of 100
  // RELAY-5: refresh access token per batch so long runs don't use expired tokens
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const token = await authClient.getAccessToken();
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instances: batch.map(text => ({
          content: text,
          task_type: taskType,
        })),
        parameters: { outputDimensionality: EMBEDDING_DIMENSIONS },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Vertex AI embedding failed: ${err}`);
    }

    const data = await response.json() as {
      predictions: Array<{ embeddings: { values: number[] } }>;
    };

    for (let j = 0; j < batch.length; j++) {
      results.push({
        contentHash: crypto.createHash('sha256').update(batch[j]).digest('hex'),
        embedding: data.predictions[j].embeddings.values,
      });
    }
  }

  return results;
}

export async function embedQuery(query: string): Promise<number[]> {
  const results = await embedTexts([query], 'RETRIEVAL_QUERY');
  return results[0].embedding;
}
