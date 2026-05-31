import { createVertex } from '@ai-sdk/google-vertex';
import { generateText } from 'ai';
import { getGcpCredentials } from '@serverless-saas/ai';

export async function extractQuestions(chunkText: string): Promise<string[]> {
  try {
    const credentials = await getGcpCredentials();

    const vertex = createVertex({
      project: credentials.project_id,
      location: process.env.GCP_LOCATION ?? 'us-central1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      googleAuthOptions: { credentials } as any,
    });

    const model = process.env.MASTRA_MODEL ?? 'gemini-2.5-flash';

    const { text } = await generateText({
      model: vertex(model),
      prompt: `Given the following text, generate exactly 3 questions that this passage directly answers. Return only the questions, one per line, no numbering, no preamble.

Text:
${chunkText.slice(0, 1500)}`,
    });

    const questions = text
      .split('\n')
      .map(q => q.trim())
      .filter(q => q.length > 10)
      .slice(0, 3);

    return questions;
  } catch {
    return []; // silent fail — never block ingestion
  }
}
