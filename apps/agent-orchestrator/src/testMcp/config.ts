// Internal test MCP config. Off unless TEST_MCP_ENABLED=1. When it is on, every
// value is required: a half-configured test server must not start and pick a
// default tenant. See ~/Desktop/consulate-demo/BUILD_BRIEF.md item 0.
export type TestMcpConfig = {
  port: number
  tenantId: string
  agentId: string
  email: string
  password: string
  cognitoClientId: string
  cognitoRegion: string
  selfBaseUrl: string
  apiBaseUrl: string
}

const REQUIRED = ['TEST_MCP_TENANT_ID', 'TEST_MCP_AGENT_ID', 'TEST_MCP_EMAIL', 'TEST_MCP_PASSWORD', 'TEST_MCP_COGNITO_CLIENT_ID', 'API_BASE_URL'] as const

export function loadTestMcpConfig(env: NodeJS.ProcessEnv = process.env): TestMcpConfig | null {
  if (env.TEST_MCP_ENABLED !== '1') return null
  const missing = REQUIRED.filter((k) => !env[k])
  if (missing.length) throw new Error(`test MCP enabled but missing: ${missing.join(', ')}`)
  return {
    port: Number(env.TEST_MCP_PORT ?? 3007),
    tenantId: env.TEST_MCP_TENANT_ID!,
    agentId: env.TEST_MCP_AGENT_ID!,
    email: env.TEST_MCP_EMAIL!,
    password: env.TEST_MCP_PASSWORD!,
    cognitoClientId: env.TEST_MCP_COGNITO_CLIENT_ID!,
    cognitoRegion: env.COGNITO_REGION ?? 'ap-south-1',
    selfBaseUrl: `http://127.0.0.1:${env.PORT ?? 3001}`,
    apiBaseUrl: env.API_BASE_URL!,
  }
}
