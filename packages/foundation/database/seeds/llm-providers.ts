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
}[] = [
    {
        provider: 'vertex',
        model: 'gemini-2.5-flash',
        isDefault: true,
        isPlatform: true,
        status: 'live',
        displayName: 'Gemini 2.5 Flash',
    },
    {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        isDefault: false,
        isPlatform: true,
        status: 'inactive',
        displayName: 'Claude Sonnet 4.6',
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
