import { GoogleGenAI } from '@google/genai';
import { readFileSync } from 'node:fs';

function getProjectId(): string {
  if (process.env.GCP_SA_KEY) {
    try { return JSON.parse(process.env.GCP_SA_KEY).project_id; } catch {}
  }
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile) {
    try { return JSON.parse(readFileSync(keyFile, 'utf8')).project_id; } catch {}
  }
  return process.env.GCP_PROJECT_ID ?? '';
}

let ai: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  if (!ai) {
    ai = new GoogleGenAI({ vertexai: true, project: getProjectId(), location: 'us-central1' });
  }
  return ai;
}

export async function quickGeminiCall(prompt: string): Promise<string> {
  const response = await getAI().models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });
  return response.text ?? '';
}
