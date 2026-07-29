import { Hono } from 'hono'
import { timingSafeEqual } from 'crypto'
import { Composio } from 'composio-core'
import { invalidateComposioCache } from '../mastra/composio.js'

// Curated list of Composio apps available for tenant connection.
// uniqueKey must match Composio's app registry (case-insensitive).
const COMPOSIO_CATALOGUE = [
  // ── Communication ──────────────────────────────────────────────────────────
  { appName: 'slack',             label: 'Slack',              description: 'Send messages and read channels',               scopes: ['Messages', 'Channels', 'Files'],           category: 'Communication' },
  { appName: 'discord',           label: 'Discord',            description: 'Read channels and send messages',               scopes: ['Messages', 'Channels', 'Guilds'],          category: 'Communication' },
  { appName: 'telegram',          label: 'Telegram',           description: 'Send and receive Telegram messages',            scopes: ['Messages', 'Bots', 'Chats'],               category: 'Communication' },
  { appName: 'microsoft_teams',   label: 'Microsoft Teams',   description: 'Chat, meetings and channels',                   scopes: ['Messages', 'Channels', 'Meetings'],        category: 'Communication' },
  { appName: 'zoom',              label: 'Zoom',               description: 'Create and manage meetings',                    scopes: ['Meetings', 'Recordings', 'Users'],         category: 'Communication' },
  { appName: 'whatsapp_business', label: 'WhatsApp Business', description: 'Send and receive WhatsApp messages',            scopes: ['Messages', 'Templates', 'Contacts'],       category: 'Communication' },
  { appName: 'twilio',            label: 'Twilio',             description: 'Send SMS and make calls',                       scopes: ['SMS', 'Calls', 'Phone Numbers'],           category: 'Communication' },
  { appName: 'outlook',           label: 'Outlook',            description: 'Read and send Outlook emails',                  scopes: ['Emails', 'Contacts', 'Calendar'],          category: 'Communication' },
  { appName: 'intercom',          label: 'Intercom',           description: 'Manage conversations and contacts',             scopes: ['Conversations', 'Contacts', 'Companies'],  category: 'Communication' },
  // ── Project Management ─────────────────────────────────────────────────────
  { appName: 'linear',            label: 'Linear',             description: 'Manage issues, projects and cycles',            scopes: ['Issues', 'Projects', 'Teams'],             category: 'Project Management' },
  { appName: 'asana',             label: 'Asana',              description: 'Manage tasks, projects and teams',              scopes: ['Tasks', 'Projects', 'Teams'],              category: 'Project Management' },
  { appName: 'trello',            label: 'Trello',             description: 'Manage boards, lists and cards',                scopes: ['Boards', 'Lists', 'Cards'],                category: 'Project Management' },
  { appName: 'jira',              label: 'Jira',               description: 'Create and update Jira issues',                 scopes: ['Issues', 'Projects', 'Comments'],          category: 'Project Management' },
  { appName: 'clickup',           label: 'ClickUp',            description: 'Tasks, docs and goals in one place',            scopes: ['Tasks', 'Spaces', 'Goals'],                category: 'Project Management' },
  { appName: 'monday',            label: 'Monday.com',         description: 'Manage boards, items and updates',              scopes: ['Boards', 'Items', 'Updates'],              category: 'Project Management' },
  { appName: 'basecamp',          label: 'Basecamp',           description: 'Projects, to-dos and messages',                 scopes: ['Projects', 'To-dos', 'Messages'],          category: 'Project Management' },
  { appName: 'wrike',             label: 'Wrike',              description: 'Tasks, projects and workflows',                 scopes: ['Tasks', 'Projects', 'Workflows'],          category: 'Project Management' },
  { appName: 'todoist',           label: 'Todoist',            description: 'Create and manage tasks',                       scopes: ['Tasks', 'Projects', 'Labels'],             category: 'Project Management' },
  { appName: 'height',            label: 'Height',             description: 'Tasks, lists and collaboration',                scopes: ['Tasks', 'Lists', 'Activities'],            category: 'Project Management' },
  { appName: 'shortcut',          label: 'Shortcut',           description: 'Stories, epics and sprints',                    scopes: ['Stories', 'Epics', 'Iterations'],          category: 'Project Management' },
  // ── Documents & Knowledge ──────────────────────────────────────────────────
  { appName: 'notion',            label: 'Notion',             description: 'Read and write pages and databases',            scopes: ['Pages', 'Databases', 'Blocks'],            category: 'Documents' },
  { appName: 'googledocs',        label: 'Google Docs',        description: 'Read and write Google Docs',                    scopes: ['Read', 'Write', 'Share'],                  category: 'Documents' },
  { appName: 'googlesheets',      label: 'Google Sheets',      description: 'Read and write spreadsheet data',               scopes: ['Sheets', 'Rows', 'Formulas'],              category: 'Documents' },
  { appName: 'googledrive',       label: 'Google Drive',       description: 'Search and access files in Drive',              scopes: ['Files', 'Search', 'Folders'],              category: 'Documents' },
  { appName: 'confluence',        label: 'Confluence',         description: 'Read and write Confluence pages',               scopes: ['Pages', 'Spaces', 'Comments'],             category: 'Documents' },
  { appName: 'coda',              label: 'Coda',               description: 'Read and write Coda docs and tables',           scopes: ['Docs', 'Tables', 'Pages'],                 category: 'Documents' },
  { appName: 'gitbook',           label: 'GitBook',            description: 'Manage documentation and spaces',               scopes: ['Spaces', 'Pages', 'Content'],              category: 'Documents' },
  { appName: 'onedrive',          label: 'OneDrive',           description: 'Access and manage files in OneDrive',           scopes: ['Files', 'Folders', 'Search'],              category: 'Documents' },
  { appName: 'dropbox',           label: 'Dropbox',            description: 'Upload, download and manage files',             scopes: ['Files', 'Folders', 'Sharing'],             category: 'Documents' },
  { appName: 'box',               label: 'Box',                description: 'Manage files and collaborate',                  scopes: ['Files', 'Folders', 'Collaborations'],      category: 'Documents' },
  { appName: 'contentful',        label: 'Contentful',         description: 'Manage CMS content and assets',                 scopes: ['Entries', 'Assets', 'Spaces'],             category: 'Documents' },
  { appName: 'sharepoint',        label: 'SharePoint',         description: 'Manage SharePoint sites and lists',             scopes: ['Sites', 'Lists', 'Files'],                 category: 'Documents' },
  // ── CRM & Sales ───────────────────────────────────────────────────────────
  { appName: 'hubspot',           label: 'HubSpot',            description: 'Manage contacts, deals and companies',          scopes: ['Contacts', 'Deals', 'Companies'],          category: 'CRM & Sales' },
  { appName: 'salesforce',        label: 'Salesforce',         description: 'Manage leads, contacts and opportunities',      scopes: ['Leads', 'Contacts', 'Opportunities'],      category: 'CRM & Sales' },
  { appName: 'pipedrive',         label: 'Pipedrive',          description: 'Manage deals, contacts and activities',         scopes: ['Deals', 'Contacts', 'Activities'],         category: 'CRM & Sales' },
  { appName: 'close',             label: 'Close CRM',          description: 'Leads, contacts and email sequences',           scopes: ['Leads', 'Contacts', 'Sequences'],          category: 'CRM & Sales' },
  { appName: 'freshsales',        label: 'Freshsales',         description: 'Leads, contacts and deals',                    scopes: ['Leads', 'Contacts', 'Deals'],              category: 'CRM & Sales' },
  { appName: 'zohocrm',           label: 'Zoho CRM',           description: 'Contacts, leads and deal management',           scopes: ['Contacts', 'Leads', 'Deals'],              category: 'CRM & Sales' },
  // ── Customer Support ──────────────────────────────────────────────────────
  { appName: 'zendesk',           label: 'Zendesk',            description: 'Manage support tickets and agents',             scopes: ['Tickets', 'Users', 'Comments'],            category: 'Support' },
  { appName: 'freshdesk',         label: 'Freshdesk',          description: 'Create and manage support tickets',             scopes: ['Tickets', 'Contacts', 'Comments'],         category: 'Support' },
  { appName: 'helpscout',         label: 'Help Scout',         description: 'Manage conversations and mailboxes',            scopes: ['Conversations', 'Mailboxes', 'Customers'], category: 'Support' },
  // ── Email & Marketing ─────────────────────────────────────────────────────
  { appName: 'mailchimp',         label: 'Mailchimp',          description: 'Manage campaigns, audiences and templates',     scopes: ['Campaigns', 'Audiences', 'Templates'],     category: 'Marketing' },
  { appName: 'sendgrid',          label: 'SendGrid',           description: 'Send transactional and marketing emails',       scopes: ['Emails', 'Templates', 'Lists'],            category: 'Marketing' },
  { appName: 'brevo',             label: 'Brevo',              description: 'Email marketing and SMS campaigns',             scopes: ['Campaigns', 'Contacts', 'Lists'],          category: 'Marketing' },
  { appName: 'mailerlite',        label: 'MailerLite',         description: 'Email campaigns and automations',               scopes: ['Campaigns', 'Subscribers', 'Groups'],      category: 'Marketing' },
  { appName: 'convertkit',        label: 'ConvertKit',         description: 'Email sequences and subscriber management',     scopes: ['Sequences', 'Subscribers', 'Forms'],       category: 'Marketing' },
  { appName: 'beehiiv',           label: 'Beehiiv',            description: 'Newsletter publishing and subscriber data',     scopes: ['Publications', 'Subscribers', 'Posts'],   category: 'Marketing' },
  { appName: 'klaviyo',           label: 'Klaviyo',            description: 'Email and SMS marketing automation',            scopes: ['Campaigns', 'Lists', 'Metrics'],           category: 'Marketing' },
  // ── Development ───────────────────────────────────────────────────────────
  { appName: 'github',            label: 'GitHub',             description: 'Access repos, PRs and issues',                  scopes: ['Repos', 'PRs', 'Issues'],                 category: 'Development' },
  { appName: 'gitlab',            label: 'GitLab',             description: 'Manage repos, issues and merge requests',       scopes: ['Repos', 'Issues', 'MRs'],                 category: 'Development' },
  { appName: 'bitbucket',         label: 'Bitbucket',          description: 'Repos, pull requests and pipelines',            scopes: ['Repos', 'PRs', 'Pipelines'],               category: 'Development' },
  { appName: 'sentry',            label: 'Sentry',             description: 'Monitor errors and performance issues',         scopes: ['Issues', 'Projects', 'Events'],            category: 'Development' },
  { appName: 'pagerduty',         label: 'PagerDuty',          description: 'Manage incidents and on-call schedules',        scopes: ['Incidents', 'Schedules', 'Services'],      category: 'Development' },
  { appName: 'datadog',           label: 'Datadog',            description: 'Monitor metrics, logs and traces',              scopes: ['Metrics', 'Logs', 'Monitors'],             category: 'Development' },
  { appName: 'vercel',            label: 'Vercel',             description: 'Manage deployments and projects',               scopes: ['Deployments', 'Projects', 'Domains'],      category: 'Development' },
  { appName: 'netlify',           label: 'Netlify',            description: 'Manage sites, builds and deploys',              scopes: ['Sites', 'Deploys', 'Forms'],               category: 'Development' },
  { appName: 'supabase',          label: 'Supabase',           description: 'Query and manage Supabase databases',           scopes: ['Tables', 'Auth', 'Storage'],               category: 'Development' },
  { appName: 'render',            label: 'Render',             description: 'Deploy and manage cloud services',              scopes: ['Services', 'Deploys', 'Environments'],     category: 'Development' },
  // ── Analytics ─────────────────────────────────────────────────────────────
  { appName: 'amplitude',         label: 'Amplitude',          description: 'Query events, charts and cohorts',              scopes: ['Events', 'Charts', 'Cohorts'],             category: 'Analytics' },
  { appName: 'mixpanel',          label: 'Mixpanel',           description: 'Query events and user analytics',               scopes: ['Events', 'Users', 'Funnels'],              category: 'Analytics' },
  { appName: 'segment',           label: 'Segment',            description: 'Track events and manage audiences',             scopes: ['Events', 'Audiences', 'Sources'],          category: 'Analytics' },
  { appName: 'posthog',           label: 'PostHog',            description: 'Product analytics and feature flags',           scopes: ['Events', 'Feature Flags', 'Insights'],     category: 'Analytics' },
  { appName: 'googleanalytics',   label: 'Google Analytics',   description: 'Website traffic and conversion data',           scopes: ['Reports', 'Dimensions', 'Metrics'],        category: 'Analytics' },
  // ── Productivity ──────────────────────────────────────────────────────────
  { appName: 'airtable',          label: 'Airtable',           description: 'Read and write tables and records',             scopes: ['Bases', 'Tables', 'Records'],              category: 'Productivity' },
  { appName: 'googlecalendar',    label: 'Google Calendar',    description: 'View and create calendar events',               scopes: ['Events', 'Calendars', 'Free/Busy'],        category: 'Productivity' },
  { appName: 'calendly',          label: 'Calendly',           description: 'Manage scheduling and availability',            scopes: ['Events', 'Scheduling Links', 'Users'],     category: 'Productivity' },
  { appName: 'typeform',          label: 'Typeform',           description: 'Create forms and retrieve responses',           scopes: ['Forms', 'Responses', 'Workspaces'],        category: 'Productivity' },
  { appName: 'surveymonkey',      label: 'SurveyMonkey',       description: 'Create surveys and collect responses',          scopes: ['Surveys', 'Responses', 'Collectors'],      category: 'Productivity' },
  { appName: 'harvest',           label: 'Harvest',            description: 'Track time and manage projects',                scopes: ['Time Entries', 'Projects', 'Clients'],     category: 'Productivity' },
  { appName: 'toggl',             label: 'Toggl',              description: 'Track time and manage workspaces',              scopes: ['Time Entries', 'Projects', 'Tags'],         category: 'Productivity' },
  { appName: 'clockify',          label: 'Clockify',           description: 'Time tracking and project management',          scopes: ['Time Entries', 'Projects', 'Clients'],     category: 'Productivity' },
  // ── Design & Creative ─────────────────────────────────────────────────────
  { appName: 'figma',             label: 'Figma',              description: 'Access files, components and comments',         scopes: ['Files', 'Components', 'Comments'],         category: 'Design' },
  { appName: 'miro',              label: 'Miro',               description: 'Read and update Miro boards',                   scopes: ['Boards', 'Items', 'Comments'],             category: 'Design' },
  { appName: 'canva',             label: 'Canva',              description: 'Create and manage Canva designs',               scopes: ['Designs', 'Templates', 'Assets'],          category: 'Design' },
  { appName: 'loom',              label: 'Loom',               description: 'Access and share Loom videos',                  scopes: ['Videos', 'Folders', 'Links'],              category: 'Design' },
  // ── Finance ───────────────────────────────────────────────────────────────
  { appName: 'stripe',            label: 'Stripe',             description: 'Payments, customers and subscriptions',         scopes: ['Customers', 'Payments', 'Subscriptions'],  category: 'Finance' },
  { appName: 'quickbooks',        label: 'QuickBooks',         description: 'Invoices, expenses and financial reports',      scopes: ['Invoices', 'Expenses', 'Accounts'],        category: 'Finance' },
  { appName: 'xero',              label: 'Xero',               description: 'Accounting, invoices and bank feeds',           scopes: ['Invoices', 'Accounts', 'Contacts'],        category: 'Finance' },
  { appName: 'brex',              label: 'Brex',               description: 'Spend management and corporate cards',          scopes: ['Transactions', 'Cards', 'Budgets'],        category: 'Finance' },
  { appName: 'plaid',             label: 'Plaid',              description: 'Bank account linking and transactions',         scopes: ['Accounts', 'Transactions', 'Identity'],    category: 'Finance' },
  // ── HR & People ───────────────────────────────────────────────────────────
  { appName: 'bamboohr',          label: 'BambooHR',           description: 'Employee records, PTO and org chart',           scopes: ['Employees', 'PTO', 'Reports'],             category: 'HR' },
  { appName: 'gusto',             label: 'Gusto',              description: 'Payroll, benefits and employee data',           scopes: ['Employees', 'Payroll', 'Benefits'],        category: 'HR' },
  { appName: 'rippling',          label: 'Rippling',           description: 'HR, IT and finance in one platform',            scopes: ['Employees', 'Apps', 'Groups'],             category: 'HR' },
  { appName: 'workday',           label: 'Workday',            description: 'HR, finance and planning data',                 scopes: ['Workers', 'Organizations', 'Reports'],     category: 'HR' },
  // ── E-commerce ────────────────────────────────────────────────────────────
  { appName: 'shopify',           label: 'Shopify',            description: 'Orders, products and customer data',            scopes: ['Orders', 'Products', 'Customers'],         category: 'E-commerce' },
  { appName: 'woocommerce',       label: 'WooCommerce',        description: 'Orders, products and customers',                scopes: ['Orders', 'Products', 'Customers'],         category: 'E-commerce' },
  // ── Social & Content ──────────────────────────────────────────────────────
  { appName: 'twitter',           label: 'X (Twitter)',        description: 'Post tweets and read timelines',                scopes: ['Tweets', 'Users', 'DMs'],                  category: 'Social' },
  { appName: 'linkedin',          label: 'LinkedIn',           description: 'Post content and manage connections',           scopes: ['Posts', 'Connections', 'Company Pages'],   category: 'Social' },
  { appName: 'youtube',           label: 'YouTube',            description: 'Manage videos, playlists and comments',         scopes: ['Videos', 'Playlists', 'Comments'],         category: 'Social' },
  { appName: 'reddit',            label: 'Reddit',             description: 'Read posts and submit content',                 scopes: ['Posts', 'Comments', 'Subreddits'],         category: 'Social' },
  { appName: 'webflow',           label: 'Webflow',            description: 'Manage sites, pages and CMS items',             scopes: ['Sites', 'Pages', 'CMS'],                   category: 'Social' },
  { appName: 'wordpress',         label: 'WordPress',          description: 'Manage posts, pages and media',                 scopes: ['Posts', 'Pages', 'Media'],                 category: 'Social' },
  // ── Legal & Docs ──────────────────────────────────────────────────────────
  { appName: 'docusign',          label: 'DocuSign',           description: 'Send, sign and track documents',                scopes: ['Envelopes', 'Templates', 'Signers'],       category: 'Legal' },
  { appName: 'pandadoc',          label: 'PandaDoc',           description: 'Create and send proposals and contracts',       scopes: ['Documents', 'Templates', 'Recipients'],    category: 'Legal' },
  // ── IT & Identity ─────────────────────────────────────────────────────────
  { appName: 'okta',              label: 'Okta',               description: 'Manage users, groups and apps',                 scopes: ['Users', 'Groups', 'Applications'],         category: 'IT & Identity' },
  { appName: 'servicenow',        label: 'ServiceNow',         description: 'IT service management and incidents',           scopes: ['Incidents', 'Change Requests', 'Tasks'],   category: 'IT & Identity' },
  // ── Search & Data ─────────────────────────────────────────────────────────
  { appName: 'algolia',           label: 'Algolia',            description: 'Search, manage indices and records',            scopes: ['Indices', 'Records', 'Search'],            category: 'Data' },
  { appName: 'mongodb',           label: 'MongoDB',            description: 'Query and manage MongoDB collections',          scopes: ['Collections', 'Documents', 'Aggregations'], category: 'Data' },
  { appName: 'elasticsearch',     label: 'Elasticsearch',      description: 'Index and search documents',                    scopes: ['Indices', 'Documents', 'Search'],          category: 'Data' },
  // ── Scheduling & Events ───────────────────────────────────────────────────
  { appName: 'eventbrite',        label: 'Eventbrite',         description: 'Manage events, tickets and attendees',          scopes: ['Events', 'Tickets', 'Attendees'],          category: 'Productivity' },
  { appName: 'acuityscheduling',  label: 'Acuity Scheduling',  description: 'Appointments and availability management',      scopes: ['Appointments', 'Clients', 'Calendars'],   category: 'Productivity' },
] as const

function isAuthorized(key: string | undefined): boolean {
  const expected = process.env.INTERNAL_SERVICE_KEY
  if (!expected || !key) return false
  try {
    return timingSafeEqual(Buffer.from(key), Buffer.from(expected))
  } catch {
    return false
  }
}

let _composio: Composio | null = null
function getComposio(): Composio {
  if (!_composio) {
    if (!process.env.COMPOSIO_API_KEY) throw new Error('COMPOSIO_API_KEY not set')
    _composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY })
  }
  return _composio
}

export const composioRouter = new Hono()

// GET /internal/composio/apps?tenantId=<id>
// Returns curated app list with connection status per tenant.
composioRouter.get('/internal/composio/apps', async (c) => {
  if (!isAuthorized(c.req.header('X-Service-Key'))) return c.json({ error: 'Unauthorized' }, 401)

  const tenantId = c.req.query('tenantId')
  if (!tenantId) return c.json({ error: 'tenantId required' }, 400)

  let connectedAppNames = new Set<string>()
  try {
    const res = await getComposio().connectedAccounts.list({ entityId: tenantId, status: 'ACTIVE' })
    const items: any[] = (res as any)?.items ?? []
    connectedAppNames = new Set(items.map((a: any) => (a.appUniqueId ?? a.appName ?? '').toLowerCase()))
  } catch (err) {
    console.warn('[composio] list connected accounts failed:', (err as Error).message)
  }

  const apps = COMPOSIO_CATALOGUE.map((app) => ({
    ...app,
    connected: connectedAppNames.has(app.appName.toLowerCase()),
  }))

  return c.json({ apps })
})

// POST /internal/composio/connect
// Body: { tenantId, appName, redirectUrl }
// Returns: { url } — OAuth redirect URL from Composio
composioRouter.post('/internal/composio/connect', async (c) => {
  if (!isAuthorized(c.req.header('X-Service-Key'))) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json() as { tenantId?: string; appName?: string; redirectUrl?: string }
  const { tenantId, appName, redirectUrl } = body
  if (!tenantId || !appName || !redirectUrl) return c.json({ error: 'tenantId, appName, redirectUrl required' }, 400)

  const catalogue = COMPOSIO_CATALOGUE.find((a) => a.appName === appName)
  if (!catalogue) return c.json({ error: `Unknown app: ${appName}` }, 400)

  const request = await getComposio().connectedAccounts.initiate({
    appName,
    entityId: tenantId,
    redirectUri: redirectUrl,
  })

  const url = (request as any).redirectUrl ?? (request as any).connectionUrl
  if (!url) return c.json({ error: 'Composio did not return a redirect URL' }, 502)

  return c.json({ url })
})

// DELETE /internal/composio/disconnect
// Body: { tenantId, appName }
composioRouter.delete('/internal/composio/disconnect', async (c) => {
  if (!isAuthorized(c.req.header('X-Service-Key'))) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json() as { tenantId?: string; appName?: string }
  const { tenantId, appName } = body
  if (!tenantId || !appName) return c.json({ error: 'tenantId, appName required' }, 400)

  let disconnected = false
  try {
    const res = await getComposio().connectedAccounts.list({ entityId: tenantId, appName })
    const items: any[] = (res as any)?.items ?? []
    for (const account of items) {
      const id = account.id ?? account.connectedAccountId
      if (id) {
        await getComposio().connectedAccounts.delete({ connectedAccountId: id })
        disconnected = true
      }
    }
  } catch (err) {
    console.error('[composio] disconnect failed:', (err as Error).message)
    return c.json({ error: 'Failed to disconnect' }, 502)
  }

  // Bust the tool cache so the next request picks up the removal immediately.
  invalidateComposioCache(tenantId)

  return c.json({ ok: true, disconnected })
})
