import { Github } from "lucide-react";
import {
    GmailIcon, DriveIcon, CalendarIcon, ZohoIcon, JiraIcon,
    M365Icon, SlackIcon, NotionIcon, WhatsAppIcon,
} from "./_integrationIcons";

export interface CatalogueEntry {
    provider: string;
    name: string;
    description: string;
    scopes: string[];
    icon: React.ReactNode;
    available: boolean;
    requiresApproval?: boolean;
}

export const CONNECT_URLS: Record<string, string> = {
    gmail:     '/api/v1/integrations/google/gmail/connect',
    drive:     '/api/v1/integrations/google/drive/connect',
    calendar:  '/api/v1/integrations/google/calendar/connect',
    zoho_crm:  '/api/v1/integrations/zoho/crm/connect',
    zoho_mail: '/api/v1/integrations/zoho/mail/connect',
    zoho_cliq: '/api/v1/integrations/zoho/cliq/connect',
    jira:      '/api/v1/integrations/jira/connect',
    github:    '/api/v1/integrations/github/connect',
};

export const CONNECTED_NAMES: Record<string, string> = {
    gmail:     'Gmail',
    drive:     'Google Drive',
    calendar:  'Google Calendar',
    zoho_crm:  'Zoho CRM',
    zoho_mail: 'Zoho Mail',
    zoho_cliq: 'Zoho Cliq',
    jira:      'Jira',
    github:    'GitHub',
};

export const CATALOGUE: CatalogueEntry[] = [
    {
        provider: 'gmail',
        name: 'Gmail',
        description: 'Read, search and send emails',
        scopes: ['Read', 'Search', 'Send'],
        icon: <GmailIcon className="w-8 h-8" />,
        available: true,
    },
    {
        provider: 'drive',
        name: 'Google Drive',
        description: 'Search and read files from Drive',
        scopes: ['Files', 'Search', 'Read'],
        icon: <DriveIcon className="w-8 h-8" />,
        available: true,
    },
    {
        provider: 'calendar',
        name: 'Google Calendar',
        description: 'View and create calendar events',
        scopes: ['Events', 'Calendars'],
        icon: <CalendarIcon className="w-8 h-8" />,
        available: true,
    },
    {
        provider: 'zoho_crm',
        name: 'Zoho CRM',
        description: 'Manage contacts, leads and deals',
        scopes: ['Contacts', 'Leads', 'Deals'],
        icon: <ZohoIcon className="w-8 h-8" />,
        available: true,
    },
    {
        provider: 'zoho_mail',
        name: 'Zoho Mail',
        description: 'Read and send emails via Zoho Mail',
        scopes: ['Messages', 'Folders'],
        icon: <ZohoIcon className="w-8 h-8" />,
        available: true,
    },
    {
        provider: 'zoho_cliq',
        name: 'Zoho Cliq',
        description: 'Send messages and read channels',
        scopes: ['Messages', 'Channels'],
        icon: <ZohoIcon className="w-8 h-8" />,
        available: true,
    },
    {
        provider: 'jira',
        name: 'Jira',
        description: 'Read and write issues and projects',
        scopes: ['Issues', 'Projects', 'Comments'],
        icon: <JiraIcon className="w-8 h-8" />,
        available: true,
    },
    {
        provider: 'github',
        name: 'GitHub',
        description: 'Connect repos — PR merges keep your codebase knowledge base up to date',
        scopes: ['Repos', 'Contents', 'Webhooks'],
        icon: <Github className="w-8 h-8" />,
        available: true,
    },
    {
        provider: 'microsoft',
        name: 'Microsoft 365',
        description: 'Outlook, OneDrive and Teams',
        scopes: ['Outlook', 'OneDrive', 'Teams'],
        icon: <M365Icon className="w-8 h-8" />,
        available: false,
    },
    {
        provider: 'slack',
        name: 'Slack',
        description: 'Send messages and read channels',
        scopes: ['Messages', 'Channels', 'Files'],
        icon: <SlackIcon className="w-8 h-8" />,
        available: false,
    },
    {
        provider: 'notion',
        name: 'Notion',
        description: 'Read and write pages and databases',
        scopes: ['Pages', 'Databases', 'Blocks'],
        icon: <NotionIcon className="w-8 h-8" />,
        available: false,
    },
    {
        provider: 'whatsapp',
        name: 'WhatsApp Business',
        description: 'Send and receive WhatsApp messages',
        scopes: ['Messages', 'Templates', 'Contacts'],
        icon: <WhatsAppIcon className="w-8 h-8" />,
        available: false,
    },
];

