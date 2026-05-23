// @serverless-saas/api
export { };

import { handle } from 'hono/aws-lambda';
import { app } from './app';
import { initRuntimeSecrets } from '@serverless-saas/secrets';

let initialized = false;

export const handler = async (event: any, context: any) => {
    if (!initialized) {
        await initRuntimeSecrets();
        initialized = true;
    }
    console.log('RAW PATH:', event.rawPath, 'ROUTE KEY:', event.routeKey);
    return handle(app)(event, context);
};// force rebuild 1773575239
// force rebuild 1773589902
// force rebuild 1773596926
// force rebuild 1773598115
// force 1774646037
