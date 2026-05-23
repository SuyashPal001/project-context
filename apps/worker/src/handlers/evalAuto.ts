import { generateTextVertex } from '@serverless-saas/ai';
import { db } from '../db';
import { evalResults } from '@serverless-saas/agent-schema';

export interface EvalAutoPayload {
  conversationId: string;
  messageId: string;
  tenantId: string;
  question: string;
  retrievedChunks: string[];
  answer: string;
}

interface EvalScores {
  faithfulness: number;
  relevance: number;
  completeness: number;
  reasoning: string;
}

async function scoreWithGemini(payload: EvalAutoPayload): Promise<EvalScores> {
  const chunksText = payload.retrievedChunks
    .map((c, i) => `[${i + 1}] ${c}`)
    .join('\n\n');

  const prompt = `You are an eval judge. Score this RAG response.

Question: ${payload.question}

Retrieved chunks:
${chunksText}

Answer: ${payload.answer}

Score each dimension 1-5:
- faithfulness: Does the answer stick to the retrieved chunks only?
- relevance: Does the answer actually address the question?
- completeness: Is the answer complete or does it cut short?

Respond in JSON only:
{ "faithfulness": 3, "relevance": 4, "completeness": 5, "reasoning": "..." }`;

  const text = await generateTextVertex({
    prompt,
    temperature: 0,
  });

  // Strip markdown fences if Gemini wraps in ```json ... ```
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned) as EvalScores;
}

export async function handleEvalAuto(body: Record<string, unknown>): Promise<void> {
  const payload = body.payload as EvalAutoPayload | undefined;

  if (!payload?.conversationId || !payload?.messageId || !payload?.tenantId) {
    console.warn('[evalAuto] Missing required fields — skipping', payload);
    return;
  }

  try {
    const scores = await scoreWithGemini(payload);

    const dimensions = ['faithfulness', 'relevance', 'completeness'] as const;
    const clamp = (n: number) => Math.max(1, Math.min(5, Math.round(n)));

    for (const dim of dimensions) {
      const score = clamp(scores[dim] ?? 3);
      await db.insert(evalResults).values({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        tenantId: payload.tenantId,
        dimension: dim,
        score,
        reasoning: scores.reasoning ?? null,
      });
    }

    console.log('[evalAuto] scored', {
      messageId: payload.messageId,
      faithfulness: scores.faithfulness,
      relevance: scores.relevance,
      completeness: scores.completeness,
    });
  } catch (err) {
    // Fire-and-forget — log but never throw so SQS does not retry on eval failure
    console.error('[evalAuto] failed', { messageId: payload.messageId, err });
  }
}
