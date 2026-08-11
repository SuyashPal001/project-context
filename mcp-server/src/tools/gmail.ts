import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { checkPolicy } from '../db/credentials';
import { getGmailAccessToken } from '../integrations/nangoGmail';
import { assertActionAllowed } from './policy-guard';

interface ToolContext {
  tenantId: string;
  agentId?: string;
}

export async function getGmailClient(tenantId: string) {
  const accessToken = await getGmailAccessToken(tenantId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth });
}

/**
 * Enforce agent policy before any Gmail action, including reads.
 *
 * Delegates to assertActionAllowed, which fails closed when agent context is
 * absent — the previous implementation returned early in that case, so omitting
 * the optional x-agent-id header skipped the block list and the human-approval
 * gate entirely. Translates the denial into the MCP error shape.
 */
async function guardPolicy(ctx: ToolContext, action: string): Promise<void> {
  try {
    await assertActionAllowed(ctx, action, checkPolicy);
  } catch (err) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      err instanceof Error ? err.message : `Action '${action}' denied`
    );
  }
}

export function registerGmailTools(server: McpServer, ctx: ToolContext): void {
  // ── GMAIL_SEND_EMAIL ────────────────────────────────────────────────────────
  server.tool(
    'GMAIL_SEND_EMAIL',
    'Send an email from the connected Gmail account',
    {
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body in plain text or HTML'),
      cc: z.string().optional().describe('CC recipients comma separated'),
    },
    async ({ to, subject, body, cc }) => {
      await guardPolicy(ctx, 'GMAIL_SEND_EMAIL');
      try {
        const gmail = await getGmailClient(ctx.tenantId);
        const lines = [
          `To: ${to}`,
          ...(cc ? [`Cc: ${cc}`] : []),
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          body,
        ];
        const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
        const result = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw },
        });
        return {
          content: [{ type: 'text' as const, text: `Email sent. Message ID: ${result.data.id}` }],
        };
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to send email: ${(err as Error).message}`
        );
      }
    }
  );

  // ── GMAIL_READ_EMAIL ────────────────────────────────────────────────────────
  server.tool(
    'GMAIL_READ_EMAIL',
    'Read a Gmail message by ID',
    {
      messageId: z.string().describe('Gmail message ID to read'),
    },
    async ({ messageId }) => {
      await guardPolicy(ctx, 'GMAIL_READ_EMAIL');
      try {
        const gmail = await getGmailClient(ctx.tenantId);
        const result = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        });

        const msg = result.data;
        const headers = msg.payload?.headers ?? [];
        const get = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

        const snippet = msg.snippet ?? '';
        const bodyData = msg.payload?.parts?.[0]?.body?.data ?? msg.payload?.body?.data ?? '';
        const bodyText = bodyData
          ? Buffer.from(bodyData, 'base64').toString('utf8')
          : snippet;

        const summary = [
          `From: ${get('from')}`,
          `To: ${get('to')}`,
          `Subject: ${get('subject')}`,
          `Date: ${get('date')}`,
          '',
          bodyText,
        ].join('\n');

        return { content: [{ type: 'text' as const, text: summary }] };
      } catch (err) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to read email: ${(err as Error).message}`
        );
      }
    }
  );

  // ── GMAIL_SEARCH_EMAILS ─────────────────────────────────────────────────────
  server.tool(
    'GMAIL_SEARCH_EMAILS',
    'Search Gmail messages using a query string',
    {
      query: z
        .string()
        .describe("Gmail search query e.g. 'from:john subject:report'"),
      maxResults: z.number().optional().default(10),
    },
    async ({ query, maxResults }) => {
      await guardPolicy(ctx, 'GMAIL_SEARCH_EMAILS');
      try {
        const gmail = await getGmailClient(ctx.tenantId);
        const listResult = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: Math.min(maxResults, 50),
        });

        const messages = listResult.data.messages ?? [];
        if (messages.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No messages found.' }] };
        }

        const summaries = await Promise.all(
          messages.map(async (m) => {
            const msg = await gmail.users.messages.get({
              userId: 'me',
              id: m.id!,
              format: 'metadata',
              metadataHeaders: ['From', 'Subject', 'Date'],
            });
            const headers = msg.data.payload?.headers ?? [];
            const get = (name: string) =>
              headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
            return `[${m.id}] ${get('date')} | From: ${get('from')} | Subject: ${get('subject')}`;
          })
        );

        return {
          content: [{ type: 'text' as const, text: summaries.join('\n') }],
        };
      } catch (err) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to search emails: ${(err as Error).message}`
        );
      }
    }
  );

  // ── GMAIL_REPLY_EMAIL ───────────────────────────────────────────────────────
  server.tool(
    'GMAIL_REPLY_EMAIL',
    'Reply to an existing Gmail message',
    {
      messageId: z.string().describe('Message ID to reply to'),
      body: z.string().describe('Reply body text'),
    },
    async ({ messageId, body }) => {
      await guardPolicy(ctx, 'GMAIL_REPLY_EMAIL');
      try {
        const gmail = await getGmailClient(ctx.tenantId);
        const original = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Message-ID', 'References'],
        });

        const headers = original.data.payload?.headers ?? [];
        const get = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

        const replyTo = get('from');
        const subject = get('subject').startsWith('Re:')
          ? get('subject')
          : `Re: ${get('subject')}`;
        const messageIdHeader = get('message-id');
        const references = get('references')
          ? `${get('references')} ${messageIdHeader}`
          : messageIdHeader;
        const threadId = original.data.threadId;

        const lines = [
          `To: ${replyTo}`,
          `Subject: ${subject}`,
          `In-Reply-To: ${messageIdHeader}`,
          `References: ${references}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          body,
        ];
        const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

        const result = await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw, threadId: threadId ?? undefined },
        });

        return {
          content: [{ type: 'text' as const, text: `Reply sent. Message ID: ${result.data.id}` }],
        };
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to reply to email: ${(err as Error).message}`
        );
      }
    }
  );
}
