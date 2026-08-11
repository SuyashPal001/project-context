import type { ApiKeyType } from '@serverless-saas/types';

// ============================================
// MCP Tool Definition
// ============================================

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpInputSchema;
  requiredPermissions: string[];
}

export interface McpInputSchema {
  type: 'object';
  properties: Record<string, McpPropertySchema>;
  required?: string[];
}

export interface McpPropertySchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  items?: McpPropertySchema;
  default?: unknown;
}

// ============================================
// MCP Request / Response
// ============================================

export interface McpRequest {
  method: string;
  params?: Record<string, unknown>;
}

export interface McpToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolCallResponse {
  content: McpContent[];
  isError?: boolean;
}

export interface McpContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

// ============================================
// MCP Server Info
// ============================================

export interface McpServerInfo {
  name: string;
  version: string;
  capabilities: McpCapabilities;
}

export interface McpCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
}

// ============================================
// MCP Auth Context
// ============================================

export interface McpAuthContext {
  tenantId: string;
  keyId: string;
  keyType: ApiKeyType;
  permissions: string[];
  agentId?: string;
}
