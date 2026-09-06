import { and, eq, isNull } from 'drizzle-orm';
import { llmProviders } from '../schema/index';
import type { db as DB } from './index';

const PLATFORM_LLM_PROVIDERS: {
    provider: 'openai' | 'anthropic' | 'mistral' | 'openrouter' | 'kimi' | 'vertex';
    model: string;
    isDefault: boolean;
    isPlatform: boolean;
    status: string;
    displayName: string;
    costPerToken: string;
}[] = [
    {
        provider: 'vertex',
        model: 'gemini-2.5-flash',
        isDefault: true,
        isPlatform: true,
        status: 'live',
        displayName: 'Gemini 2.5 Flash',
        costPerToken: '0.00000400',
    },
    {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        isDefault: false,
        isPlatform: true,
        status: 'inactive',
        displayName: 'Claude Sonnet 4.6',
        costPerToken: '0.00002000',
    },
    // Curated "top companies" set added 2026-09-06, routed through OpenRouter
    // rather than direct provider keys — the DB "provider" enum column stays
    // 'openrouter' for all four; the real upstream model lives in `model`
    // ("brand/slug"), which buildGatewayModelString (apps/agent-orchestrator/
    // src/mastra/model.ts) prefixes with "openrouter/" for the gateway, and
    // which ProviderIcon.iconKey reads to pick each brand's icon since the
    // provider column alone can't distinguish them. Requires OPENROUTER_API_KEY
    // set on the inference-gateway VM — until then these 404/503 if selected.
    {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5',
        isDefault: false,
        isPlatform: true,
        status: 'live',
        displayName: 'Claude Sonnet 5',
        costPerToken: '0.00000900',
    },
    {
        provider: 'openrouter',
        model: 'openai/gpt-5.2',
        isDefault: false,
        isPlatform: true,
        status: 'live',
        displayName: 'GPT-5.2',
        costPerToken: '0.00000788',
    },
    {
        provider: 'openrouter',
        model: 'z-ai/glm-4.6',
        isDefault: false,
        isPlatform: true,
        status: 'live',
        displayName: 'GLM-4.6',
        costPerToken: '0.00000109',
    },
    {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2.6',
        isDefault: false,
        isPlatform: true,
        status: 'live',
        displayName: 'Kimi K2.6',
        costPerToken: '0.00000143',
    },
    {
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-pro',
        isDefault: false,
        isPlatform: true,
        status: 'live',
        displayName: 'DeepSeek V4 Pro',
        costPerToken: '0.00000065',
    },
];

export async function seedLlmProviders(db: typeof DB) {
    console.log('seeding llm_providers');

    for (const row of PLATFORM_LLM_PROVIDERS) {
        // Platform rows have tenantId = NULL — match on provider + model + isPlatform
        const existing = await db
            .select({ id: llmProviders.id })
            .from(llmProviders)
            .where(
                and(
                    eq(llmProviders.provider, row.provider),
                    eq(llmProviders.model, row.model),
                    eq(llmProviders.isPlatform, true),
                    isNull(llmProviders.tenantId)
                )
            )
            .limit(1);

        if (existing.length > 0) {
            console.log(`  skip ${row.provider}/${row.model}`);
            continue;
        }

        await db.insert(llmProviders).values({
            ...row,
            apiKeyEncrypted: '',  // platform key injected at runtime via env/secrets
            tenantId: null,
        });
        console.log(`  inserted ${row.provider}/${row.model}`);
    }
}
