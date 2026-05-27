import { createStep } from '@mastra/core/workflows';
import { ruleValidationOutputSchema, findingAssemblyOutputSchema } from './pensionWorkflow.schemas.js';

const INFERENCE_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001';
const NARRATION_MODEL = process.env.DEFAULT_MODEL ?? 'ollama/qwen2.5:7b';

async function narrate(message: string, provision: string): Promise<string> {
  try {
    const res = await fetch(`${INFERENCE_URL}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: NARRATION_MODEL,
        messages: [
          { role: 'system', content: 'You are a CAG pension auditor. Rewrite the finding in one clear, formal sentence for an officer. Do not change any numbers. Cite the provision.' },
          { role: 'user', content: `Finding: ${message}\nProvision: ${provision}` },
        ],
        stream: false,
      }),
    });
    if (!res.ok) return message;
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() || message;
  } catch {
    return message; // fall back to deterministic message
  }
}

export const findingAssemblyStep = createStep({
  id: 'pension-finding-assembly',
  inputSchema: ruleValidationOutputSchema,
  outputSchema: findingAssemblyOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData.complete) {
      return { ...inputData, findings: [], caseStatus: 'incomplete' as const };
    }
    const flagged = inputData.ruleResults.filter(r => r.status === 'fail' || r.status === 'cannot_evaluate');

    const findings = await Promise.all(flagged.map(async (r) => {
      const narration = await narrate(r.message, r.provision);
      let math = null;
      if (r.ruleId === 'R002') {
        math = {
          expression: `Last Pay × Qualifying Service / 66 = ${r.calculated}`,
          inputs: ['last_pay', 'qualifying_service_years'].map(key => ({
            key, value: inputData.fields[key],
            sourceDoc: inputData.fieldSources[key]?.sourceDoc ?? 'unknown',
            sourcePage: inputData.fieldSources[key]?.sourcePage ?? 0,
          })),
        };
      }
      return {
        ruleId: r.ruleId, ruleName: r.ruleName, status: r.status, provision: r.provision,
        narration, declaredValue: r.declared, calculatedValue: r.calculated, math,
      };
    }));

    const caseStatus = findings.length === 0 ? ('cleared' as const) : ('pending_review' as const);
    return { ...inputData, findings, caseStatus };
  },
});
