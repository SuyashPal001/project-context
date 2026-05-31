import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

export const isPlatformAdmin = (c: Context<AppEnv>): boolean => {
    const jwtPayload = c.get('jwtPayload') as Record<string, unknown> | undefined;
    return jwtPayload?.['custom:role'] === 'platform_admin';
};
