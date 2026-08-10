import { isNull } from 'drizzle-orm';
import { agentTools } from '@serverless-saas/agent-schema/agents';
import type { db as DB } from './index';

type Stakes = 'low' | 'medium' | 'high' | 'critical';

const PLATFORM_TOOLS: {
  name: string;
  displayName: string;
  description: string;
  provider: string | null;
  stakes: Stakes;
  requiresApproval: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  status?: string;
  parametersSchema: Record<string, unknown> | null;
}[] = [
  // ── Gmail ──────────────────────────────────────────────────────────────────
  {
    name: 'gmail_list_messages',
    displayName: 'List Gmail Messages',
    description: 'List Gmail messages matching a query',
    provider: 'gmail',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'gmail_get_message',
    displayName: 'Get Gmail Message',
    description: 'Fetch a single Gmail message by ID',
    provider: 'gmail',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] },
  },
  {
    name: 'gmail_send_message',
    displayName: 'Send Gmail Message',
    description: 'Send an email via Gmail',
    provider: 'gmail',
    stakes: 'high',
    requiresApproval: true,
    parametersSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, replyToMessageId: { type: 'string' } }, required: ['to', 'subject', 'body'] },
  },
  // ── Google Drive ───────────────────────────────────────────────────────────
  {
    name: 'drive_list_files',
    displayName: 'List Drive Files',
    description: 'List Google Drive files',
    provider: 'drive',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { query: { type: 'string' }, pageSize: { type: 'number' } } },
  },
  {
    name: 'drive_get_file',
    displayName: 'Get Drive File',
    description: 'Get Google Drive file metadata',
    provider: 'drive',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
  },
  {
    name: 'drive_export_doc',
    displayName: 'Export Google Doc',
    description: 'Export a Google Doc as plain text',
    provider: 'drive',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { fileId: { type: 'string' }, mimeType: { type: 'string' } }, required: ['fileId'] },
  },
  // ── Google Calendar ────────────────────────────────────────────────────────
  {
    name: 'calendar_list_events',
    displayName: 'List Calendar Events',
    description: 'List Google Calendar events',
    provider: 'calendar',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { calendarId: { type: 'string' }, timeMin: { type: 'string' }, timeMax: { type: 'string' }, maxResults: { type: 'number' } } },
  },
  {
    name: 'calendar_create_event',
    displayName: 'Create Calendar Event',
    description: 'Create a Google Calendar event',
    provider: 'calendar',
    stakes: 'medium',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { summary: { type: 'string' }, description: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'start', 'end'] },
  },
  {
    name: 'calendar_update_event',
    displayName: 'Update Calendar Event',
    description: 'Update an existing calendar event',
    provider: 'calendar',
    stakes: 'medium',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { eventId: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } }, required: ['eventId'] },
  },
  // ── Zoho CRM ───────────────────────────────────────────────────────────────
  {
    name: 'zoho_search_contacts',
    displayName: 'Search Zoho Contacts',
    description: 'Search contacts in Zoho CRM',
    provider: 'zoho_crm',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'zoho_get_contact',
    displayName: 'Get Zoho Contact',
    description: 'Get a Zoho CRM contact by ID',
    provider: 'zoho_crm',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { contactId: { type: 'string' } }, required: ['contactId'] },
  },
  {
    name: 'zoho_create_contact',
    displayName: 'Create Zoho Contact',
    description: 'Create a new contact in Zoho CRM',
    provider: 'zoho_crm',
    stakes: 'medium',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { firstName: { type: 'string' }, lastName: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, accountName: { type: 'string' }, title: { type: 'string' } }, required: ['lastName'] },
  },
  {
    name: 'zoho_search_deals',
    displayName: 'Search Zoho Deals',
    description: 'Search deals in Zoho CRM',
    provider: 'zoho_crm',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'zoho_create_deal',
    displayName: 'Create Zoho Deal',
    description: 'Create a new deal in Zoho CRM',
    provider: 'zoho_crm',
    stakes: 'medium',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { dealName: { type: 'string' }, stage: { type: 'string' }, amount: { type: 'number' }, closingDate: { type: 'string' }, accountName: { type: 'string' }, contactName: { type: 'string' } }, required: ['dealName', 'stage'] },
  },
  // ── Zoho Mail ──────────────────────────────────────────────────────────────
  {
    name: 'zoho_mail_list_messages',
    displayName: 'List Zoho Mail Messages',
    description: 'Search and list Zoho Mail messages',
    provider: 'zoho_mail',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'zoho_mail_get_message',
    displayName: 'Get Zoho Mail Message',
    description: 'Get a Zoho Mail message by ID',
    provider: 'zoho_mail',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { messageId: { type: 'string' }, folderId: { type: 'string' } }, required: ['messageId', 'folderId'] },
  },
  {
    name: 'zoho_mail_send_message',
    displayName: 'Send Zoho Mail Message',
    description: 'Send an email via Zoho Mail',
    provider: 'zoho_mail',
    stakes: 'high',
    requiresApproval: true,
    parametersSchema: { type: 'object', properties: { toAddress: { type: 'string' }, subject: { type: 'string' }, content: { type: 'string' }, fromAddress: { type: 'string' }, ccAddress: { type: 'string' } }, required: ['toAddress', 'subject', 'content'] },
  },
  // ── Zoho Cliq ─────────────────────────────────────────────────────────────
  {
    name: 'zoho_cliq_list_channels',
    displayName: 'List Zoho Cliq Channels',
    description: 'List Zoho Cliq channels',
    provider: 'zoho_cliq',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zoho_cliq_get_channel_messages',
    displayName: 'Get Zoho Cliq Messages',
    description: 'Get messages from a Zoho Cliq channel',
    provider: 'zoho_cliq',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { channelName: { type: 'string' }, count: { type: 'number' } }, required: ['channelName'] },
  },
  {
    name: 'zoho_cliq_send_message',
    displayName: 'Send Zoho Cliq Message',
    description: 'Send a message to a Zoho Cliq channel or user',
    provider: 'zoho_cliq',
    stakes: 'high',
    requiresApproval: true,
    parametersSchema: { type: 'object', properties: { text: { type: 'string' }, channelName: { type: 'string' }, userEmail: { type: 'string' } }, required: ['text'] },
  },
  // ── Jira ──────────────────────────────────────────────────────────────────
  {
    name: 'jira_search_issues',
    displayName: 'Search Jira Issues',
    description: 'Search Jira issues by keyword',
    provider: 'jira',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'jira_get_issue',
    displayName: 'Get Jira Issue',
    description: 'Get a Jira issue by key (e.g. PROJ-123)',
    provider: 'jira',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { issueKey: { type: 'string' } }, required: ['issueKey'] },
  },
  {
    name: 'jira_create_issue',
    displayName: 'Create Jira Issue',
    description: 'Create a new Jira issue',
    provider: 'jira',
    stakes: 'medium',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { projectKey: { type: 'string' }, summary: { type: 'string' }, issueType: { type: 'string' }, description: { type: 'string' }, assigneeEmail: { type: 'string' }, priority: { type: 'string' } }, required: ['projectKey', 'summary'] },
  },
  {
    name: 'jira_update_issue',
    displayName: 'Update Jira Issue',
    description: 'Update fields on an existing Jira issue',
    provider: 'jira',
    stakes: 'medium',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { issueKey: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' }, assigneeEmail: { type: 'string' }, priority: { type: 'string' } }, required: ['issueKey'] },
  },
  {
    name: 'jira_list_projects',
    displayName: 'List Jira Projects',
    description: 'List all Jira projects',
    provider: 'jira',
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: {} },
  },
  // ── Platform (no provider required) ───────────────────────────────────────
  {
    name: 'start_task',
    displayName: 'Start Task',
    description: "Fetch everything needed to start work on a task: title/description/status, resolved plan steps, linked project context, and repo reference.",
    provider: null,
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
  },
  {
    name: 'get_task_thread',
    displayName: 'Get Task Thread',
    description: 'Fetch the full comment history for a task.',
    provider: null,
    stakes: 'low',
    requiresApproval: false,
    parametersSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
  },
  {
    name: 'web_search',
    displayName: 'Web Search',
    description: 'Search the web for current information, news, facts, and real-time data',
    provider: null,
    stakes: 'low',
    requiresApproval: false,
    maxRetries: 2,
    timeoutMs: 15000,
    status: 'active' as const,
    parametersSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
  },
];

export async function seedTools(db: typeof DB): Promise<void> {
  // Idempotent: skip if platform tools already seeded
  const existing = await db
    .select({ id: agentTools.id })
    .from(agentTools)
    .where(isNull(agentTools.tenantId))
    .limit(1);

  if (existing.length > 0) {
    console.log('agentTools already seeded, skipping');
    return;
  }

  await db.insert(agentTools).values(
    PLATFORM_TOOLS.map((t) => ({
      tenantId: null,
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      provider: t.provider,
      parametersSchema: t.parametersSchema,
      stakes: t.stakes,
      requiresApproval: t.requiresApproval,
      ...(t.maxRetries !== undefined && { maxRetries: t.maxRetries }),
      ...(t.timeoutMs !== undefined && { timeoutMs: t.timeoutMs }),
      ...(t.status !== undefined && { status: t.status }),
    }))
  );

  console.log(`seeded ${PLATFORM_TOOLS.length} platform tools`);
}
