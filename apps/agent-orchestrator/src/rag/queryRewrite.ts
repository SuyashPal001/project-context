import { quickGeminiCall } from '../llm/quickCall.js';

const PRONOUNS = /\b(it|this|that|he|she|they|them|its|their|those|these)\b/i;

export async function rewriteQuery(message: string, history: { role: string; content: string }[]): Promise<string> {
  if (!PRONOUNS.test(message) || history.length === 0) return message;

  const historyText = history.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');

  const prompt = `Given the chat history and the user's latest message, provide a standalone search query that is self-contained and could be understood without the previous context.

Rules:
- Replace "it", "that", "this" with the actual entity from history
- Remove conversational filler
- Keep under 20 words
- If already self-contained, return unchanged

Chat History:
${historyText}

User's Latest Message: "${message}"

Standalone Search Query:`;

  const result = await quickGeminiCall(prompt);
  return result.trim() || message;
}
