import { describe, it, expect } from 'vitest'
import { loadTestMcpConfig } from './config.js'

const full = {
  TEST_MCP_ENABLED: '1', TEST_MCP_TENANT_ID: 't1', TEST_MCP_AGENT_ID: 'a1',
  TEST_MCP_EMAIL: 'x@y.z', TEST_MCP_PASSWORD: 'pw', TEST_MCP_COGNITO_CLIENT_ID: 'cid',
  COGNITO_REGION: 'ap-south-1', API_BASE_URL: 'https://api.example', PORT: '3001',
}

describe('loadTestMcpConfig', () => {
  it('is null unless TEST_MCP_ENABLED=1', () => {
    expect(loadTestMcpConfig({ ...full, TEST_MCP_ENABLED: '' })).toBeNull()
  })
  it('throws listing every missing var when enabled', () => {
    expect(() => loadTestMcpConfig({ TEST_MCP_ENABLED: '1' })).toThrow(/TEST_MCP_TENANT_ID.*TEST_MCP_AGENT_ID/s)
  })
  it('defaults port 3007 and self URL to the orchestrator port on 127.0.0.1', () => {
    const c = loadTestMcpConfig(full)!
    expect(c.port).toBe(3007)
    expect(c.selfBaseUrl).toBe('http://127.0.0.1:3001')
  })
})
