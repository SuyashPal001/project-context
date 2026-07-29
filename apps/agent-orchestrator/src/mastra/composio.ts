import { VercelAIToolSet } from 'composio-core'

// VercelAIToolSet returns { [key: string]: CoreTool } which is identical to
// the tool map format Mastra agents accept — no adapter needed.

const CACHE_TTL_MS = 5 * 60_000 // 5 minutes, same as MCP tool cache

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const composioCache = new Map<string, { tools: Record<string, any>; expiresAt: number }>()

let _toolset: VercelAIToolSet | null = null

function getComposioToolSet(): VercelAIToolSet {
  if (!_toolset) {
    _toolset = new VercelAIToolSet({ apiKey: process.env.COMPOSIO_API_KEY })
  }
  return _toolset
}

export function isComposioEnabled(): boolean {
  return process.env.COMPOSIO_ENABLED === 'true' && !!process.env.COMPOSIO_API_KEY
}

// --- Action allowlist -------------------------------------------------------
//
// Composio apps expose far more actions than an agent can choose between well:
// GitHub alone is 100+, Jira ~50. Every action's JSON schema is injected into
// the prompt on every turn (~200-500 tokens each), so an unfiltered tool map
// costs both money and tool-selection accuracy — models start mispicking past
// roughly 30-50 tools.
//
// So we curate. Grouped by app for readability, flattened to a Set for lookup.
// Keys are Composio action slugs exactly as they appear in the returned tool
// map. Adding a connector to the Composio catalog does NOT expose it to the
// agent — it must be listed here too.

const ALLOWED_ACTIONS_BY_APP: Record<string, string[]> = {
  // ── Communication ──────────────────────────────────────────────────────────
  gmail: [
    'GMAIL_SEND_EMAIL',
    'GMAIL_CREATE_EMAIL_DRAFT',
    'GMAIL_FETCH_EMAILS',
    'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
    'GMAIL_REPLY_TO_THREAD',
  ],
  slack: [
    'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL',
    'SLACK_LIST_ALL_CHANNELS',
    'SLACK_FETCH_CONVERSATION_HISTORY',
    'SLACK_GET_CHANNEL_MESSAGES',
  ],
  discord: [
    'DISCORD_SEND_MESSAGE',
    'DISCORD_LIST_CHANNELS',
    'DISCORD_GET_MESSAGES',
  ],
  telegram: [
    'TELEGRAM_SEND_MESSAGE',
    'TELEGRAM_GET_UPDATES',
    'TELEGRAM_SEND_PHOTO',
  ],
  microsoft_teams: [
    'MICROSOFT_TEAMS_SEND_MESSAGE',
    'MICROSOFT_TEAMS_LIST_CHANNELS',
    'MICROSOFT_TEAMS_GET_MESSAGES',
    'MICROSOFT_TEAMS_CREATE_CHANNEL',
  ],
  zoom: [
    'ZOOM_CREATE_MEETING',
    'ZOOM_LIST_MEETINGS',
    'ZOOM_GET_MEETING',
    'ZOOM_DELETE_MEETING',
  ],
  whatsapp_business: [
    'WHATSAPP_BUSINESS_SEND_MESSAGE',
    'WHATSAPP_BUSINESS_SEND_TEMPLATE_MESSAGE',
    'WHATSAPP_BUSINESS_GET_MESSAGES',
  ],
  twilio: [
    'TWILIO_SEND_SMS',
    'TWILIO_LIST_MESSAGES',
    'TWILIO_GET_MESSAGE',
  ],
  outlook: [
    'OUTLOOK_SEND_EMAIL',
    'OUTLOOK_LIST_EMAILS',
    'OUTLOOK_GET_EMAIL',
    'OUTLOOK_CREATE_DRAFT',
    'OUTLOOK_REPLY_TO_EMAIL',
  ],
  intercom: [
    'INTERCOM_LIST_CONVERSATIONS',
    'INTERCOM_GET_CONVERSATION',
    'INTERCOM_CREATE_NOTE',
    'INTERCOM_SEARCH_CONTACTS',
  ],
  // ── Project Management ─────────────────────────────────────────────────────
  linear: [
    'LINEAR_CREATE_LINEAR_ISSUE',
    'LINEAR_UPDATE_ISSUE',
    'LINEAR_LIST_LINEAR_ISSUES',
    'LINEAR_GET_LINEAR_ISSUE',
    'LINEAR_ADD_COMMENT',
  ],
  jira: [
    'JIRA_CREATE_ISSUE',
    'JIRA_UPDATE_ISSUE',
    'JIRA_GET_ISSUE',
    'JIRA_SEARCH_FOR_ISSUES_USING_JQL',
    'JIRA_ADD_COMMENT',
  ],
  asana: [
    'ASANA_CREATE_TASK',
    'ASANA_UPDATE_TASK',
    'ASANA_GET_TASK',
    'ASANA_LIST_TASKS',
    'ASANA_ADD_COMMENT',
  ],
  trello: [
    'TRELLO_CREATE_CARD',
    'TRELLO_UPDATE_CARD',
    'TRELLO_GET_CARD',
    'TRELLO_LIST_CARDS',
    'TRELLO_MOVE_CARD',
  ],
  clickup: [
    'CLICKUP_CREATE_TASK',
    'CLICKUP_UPDATE_TASK',
    'CLICKUP_GET_TASK',
    'CLICKUP_LIST_TASKS',
    'CLICKUP_CREATE_COMMENT',
  ],
  monday: [
    'MONDAY_CREATE_ITEM',
    'MONDAY_UPDATE_ITEM',
    'MONDAY_GET_ITEM',
    'MONDAY_LIST_ITEMS',
    'MONDAY_CREATE_UPDATE',
  ],
  basecamp: [
    'BASECAMP_CREATE_TODO',
    'BASECAMP_LIST_TODOS',
    'BASECAMP_CREATE_MESSAGE',
    'BASECAMP_LIST_PROJECTS',
  ],
  wrike: [
    'WRIKE_CREATE_TASK',
    'WRIKE_UPDATE_TASK',
    'WRIKE_GET_TASK',
    'WRIKE_LIST_TASKS',
  ],
  todoist: [
    'TODOIST_CREATE_TASK',
    'TODOIST_UPDATE_TASK',
    'TODOIST_COMPLETE_TASK',
    'TODOIST_LIST_TASKS',
  ],
  height: [
    'HEIGHT_CREATE_TASK',
    'HEIGHT_UPDATE_TASK',
    'HEIGHT_LIST_TASKS',
  ],
  shortcut: [
    'SHORTCUT_CREATE_STORY',
    'SHORTCUT_UPDATE_STORY',
    'SHORTCUT_GET_STORY',
    'SHORTCUT_LIST_STORIES',
  ],
  // ── Documents & Knowledge ──────────────────────────────────────────────────
  notion: [
    'NOTION_CREATE_NOTION_PAGE',
    'NOTION_ADD_PAGE_CONTENT',
    'NOTION_FETCH_DATA',
    'NOTION_QUERY_DATABASE',
    'NOTION_UPDATE_PAGE',
  ],
  googledocs: [
    'GOOGLEDOCS_CREATE_DOCUMENT',
    'GOOGLEDOCS_GET_DOCUMENT',
    'GOOGLEDOCS_UPDATE_DOCUMENT',
  ],
  googlesheets: [
    'GOOGLESHEETS_GET_SPREADSHEET',
    'GOOGLESHEETS_READ_RANGE',
    'GOOGLESHEETS_BATCH_UPDATE',
    'GOOGLESHEETS_CREATE_SPREADSHEET',
  ],
  googledrive: [
    'GOOGLEDRIVE_LIST_FILES',
    'GOOGLEDRIVE_GET_FILE',
    'GOOGLEDRIVE_UPLOAD_FILE',
    'GOOGLEDRIVE_SEARCH',
  ],
  googlecalendar: [
    'GOOGLECALENDAR_CREATE_EVENT',
    'GOOGLECALENDAR_UPDATE_EVENT',
    'GOOGLECALENDAR_DELETE_EVENT',
    'GOOGLECALENDAR_FIND_EVENT',
    'GOOGLECALENDAR_FIND_FREE_SLOTS',
  ],
  confluence: [
    'CONFLUENCE_CREATE_PAGE',
    'CONFLUENCE_UPDATE_PAGE',
    'CONFLUENCE_GET_PAGE',
    'CONFLUENCE_LIST_PAGES',
    'CONFLUENCE_SEARCH',
  ],
  coda: [
    'CODA_LIST_DOCS',
    'CODA_GET_DOC',
    'CODA_LIST_TABLES',
    'CODA_LIST_ROWS',
    'CODA_INSERT_ROWS',
  ],
  gitbook: [
    'GITBOOK_LIST_SPACES',
    'GITBOOK_GET_PAGE',
    'GITBOOK_SEARCH',
  ],
  onedrive: [
    'ONEDRIVE_LIST_FILES',
    'ONEDRIVE_GET_FILE',
    'ONEDRIVE_UPLOAD_FILE',
    'ONEDRIVE_SEARCH',
  ],
  dropbox: [
    'DROPBOX_LIST_FOLDER',
    'DROPBOX_GET_FILE_METADATA',
    'DROPBOX_UPLOAD_FILE',
    'DROPBOX_SEARCH',
  ],
  box: [
    'BOX_LIST_FOLDER',
    'BOX_GET_FILE',
    'BOX_UPLOAD_FILE',
    'BOX_SEARCH',
  ],
  contentful: [
    'CONTENTFUL_GET_ENTRY',
    'CONTENTFUL_LIST_ENTRIES',
    'CONTENTFUL_CREATE_ENTRY',
    'CONTENTFUL_UPDATE_ENTRY',
    'CONTENTFUL_PUBLISH_ENTRY',
  ],
  sharepoint: [
    'SHAREPOINT_LIST_SITES',
    'SHAREPOINT_GET_LIST_ITEMS',
    'SHAREPOINT_CREATE_LIST_ITEM',
    'SHAREPOINT_UPDATE_LIST_ITEM',
  ],
  // ── CRM & Sales ───────────────────────────────────────────────────────────
  hubspot: [
    'HUBSPOT_CREATE_CONTACT',
    'HUBSPOT_UPDATE_CONTACT',
    'HUBSPOT_GET_CONTACT',
    'HUBSPOT_LIST_CONTACTS',
    'HUBSPOT_CREATE_DEAL',
    'HUBSPOT_UPDATE_DEAL',
    'HUBSPOT_CREATE_NOTE',
  ],
  salesforce: [
    'SALESFORCE_CREATE_RECORD',
    'SALESFORCE_UPDATE_RECORD',
    'SALESFORCE_GET_RECORD',
    'SALESFORCE_SEARCH_RECORDS',
    'SALESFORCE_LIST_RECORDS',
  ],
  pipedrive: [
    'PIPEDRIVE_CREATE_DEAL',
    'PIPEDRIVE_UPDATE_DEAL',
    'PIPEDRIVE_GET_DEAL',
    'PIPEDRIVE_LIST_DEALS',
    'PIPEDRIVE_CREATE_PERSON',
    'PIPEDRIVE_CREATE_ACTIVITY',
  ],
  close: [
    'CLOSE_CREATE_LEAD',
    'CLOSE_UPDATE_LEAD',
    'CLOSE_GET_LEAD',
    'CLOSE_LIST_LEADS',
    'CLOSE_CREATE_NOTE',
  ],
  freshsales: [
    'FRESHSALES_CREATE_CONTACT',
    'FRESHSALES_UPDATE_CONTACT',
    'FRESHSALES_LIST_CONTACTS',
    'FRESHSALES_CREATE_DEAL',
  ],
  zohocrm: [
    'ZOHOCRM_CREATE_RECORD',
    'ZOHOCRM_UPDATE_RECORD',
    'ZOHOCRM_GET_RECORD',
    'ZOHOCRM_SEARCH_RECORDS',
  ],
  // ── Customer Support ──────────────────────────────────────────────────────
  zendesk: [
    'ZENDESK_CREATE_TICKET',
    'ZENDESK_UPDATE_TICKET',
    'ZENDESK_GET_TICKET',
    'ZENDESK_LIST_TICKETS',
    'ZENDESK_ADD_COMMENT',
  ],
  freshdesk: [
    'FRESHDESK_CREATE_TICKET',
    'FRESHDESK_UPDATE_TICKET',
    'FRESHDESK_GET_TICKET',
    'FRESHDESK_LIST_TICKETS',
    'FRESHDESK_CREATE_REPLY',
  ],
  helpscout: [
    'HELPSCOUT_LIST_CONVERSATIONS',
    'HELPSCOUT_GET_CONVERSATION',
    'HELPSCOUT_CREATE_CONVERSATION',
    'HELPSCOUT_REPLY_TO_CONVERSATION',
  ],
  // ── Email & Marketing ─────────────────────────────────────────────────────
  mailchimp: [
    'MAILCHIMP_ADD_MEMBER_TO_LIST',
    'MAILCHIMP_GET_LIST_MEMBER',
    'MAILCHIMP_LIST_CAMPAIGNS',
    'MAILCHIMP_GET_CAMPAIGN_REPORT',
  ],
  sendgrid: [
    'SENDGRID_SEND_EMAIL',
    'SENDGRID_LIST_CONTACTS',
    'SENDGRID_CREATE_CONTACT',
    'SENDGRID_LIST_TEMPLATES',
  ],
  brevo: [
    'BREVO_SEND_TRANSACTIONAL_EMAIL',
    'BREVO_CREATE_CONTACT',
    'BREVO_UPDATE_CONTACT',
    'BREVO_LIST_CONTACTS',
  ],
  mailerlite: [
    'MAILERLITE_LIST_SUBSCRIBERS',
    'MAILERLITE_CREATE_SUBSCRIBER',
    'MAILERLITE_LIST_CAMPAIGNS',
  ],
  convertkit: [
    'CONVERTKIT_LIST_SUBSCRIBERS',
    'CONVERTKIT_TAG_SUBSCRIBER',
    'CONVERTKIT_CREATE_BROADCAST',
  ],
  beehiiv: [
    'BEEHIIV_LIST_PUBLICATIONS',
    'BEEHIIV_GET_SUBSCRIBERS',
    'BEEHIIV_CREATE_POST',
  ],
  klaviyo: [
    'KLAVIYO_CREATE_PROFILE',
    'KLAVIYO_UPDATE_PROFILE',
    'KLAVIYO_LIST_CAMPAIGNS',
    'KLAVIYO_GET_CAMPAIGN',
  ],
  // ── Development ───────────────────────────────────────────────────────────
  github: [
    'GITHUB_CREATE_AN_ISSUE',
    'GITHUB_LIST_REPOSITORY_ISSUES',
    'GITHUB_GET_AN_ISSUE',
    'GITHUB_CREATE_AN_ISSUE_COMMENT',
    'GITHUB_LIST_PULL_REQUESTS',
    'GITHUB_GET_A_PULL_REQUEST',
    'GITHUB_CREATE_A_PULL_REQUEST',
  ],
  gitlab: [
    'GITLAB_CREATE_ISSUE',
    'GITLAB_UPDATE_ISSUE',
    'GITLAB_LIST_ISSUES',
    'GITLAB_CREATE_MERGE_REQUEST',
    'GITLAB_LIST_MERGE_REQUESTS',
  ],
  bitbucket: [
    'BITBUCKET_CREATE_ISSUE',
    'BITBUCKET_LIST_ISSUES',
    'BITBUCKET_CREATE_PULL_REQUEST',
    'BITBUCKET_LIST_PULL_REQUESTS',
  ],
  sentry: [
    'SENTRY_LIST_ISSUES',
    'SENTRY_GET_ISSUE',
    'SENTRY_UPDATE_ISSUE',
    'SENTRY_LIST_PROJECTS',
  ],
  pagerduty: [
    'PAGERDUTY_CREATE_INCIDENT',
    'PAGERDUTY_LIST_INCIDENTS',
    'PAGERDUTY_GET_INCIDENT',
    'PAGERDUTY_ACKNOWLEDGE_INCIDENT',
    'PAGERDUTY_RESOLVE_INCIDENT',
  ],
  datadog: [
    'DATADOG_LIST_MONITORS',
    'DATADOG_GET_MONITOR',
    'DATADOG_MUTE_MONITOR',
    'DATADOG_LIST_EVENTS',
  ],
  vercel: [
    'VERCEL_LIST_DEPLOYMENTS',
    'VERCEL_GET_DEPLOYMENT',
    'VERCEL_LIST_PROJECTS',
    'VERCEL_GET_PROJECT',
  ],
  netlify: [
    'NETLIFY_LIST_SITES',
    'NETLIFY_GET_SITE',
    'NETLIFY_LIST_DEPLOYS',
    'NETLIFY_GET_DEPLOY',
  ],
  supabase: [
    'SUPABASE_LIST_PROJECTS',
    'SUPABASE_GET_PROJECT',
    'SUPABASE_LIST_TABLES',
  ],
  render: [
    'RENDER_LIST_SERVICES',
    'RENDER_GET_SERVICE',
    'RENDER_LIST_DEPLOYS',
  ],
  // ── Analytics ─────────────────────────────────────────────────────────────
  amplitude: [
    'AMPLITUDE_GET_CHART',
    'AMPLITUDE_QUERY_EVENTS',
    'AMPLITUDE_LIST_COHORTS',
  ],
  mixpanel: [
    'MIXPANEL_QUERY_EVENTS',
    'MIXPANEL_GET_FUNNELS',
    'MIXPANEL_LIST_COHORTS',
  ],
  segment: [
    'SEGMENT_LIST_SOURCES',
    'SEGMENT_LIST_DESTINATIONS',
    'SEGMENT_GET_SOURCE',
  ],
  posthog: [
    'POSTHOG_GET_INSIGHTS',
    'POSTHOG_LIST_FEATURE_FLAGS',
    'POSTHOG_TOGGLE_FEATURE_FLAG',
    'POSTHOG_LIST_PERSONS',
  ],
  googleanalytics: [
    'GOOGLEANALYTICS_RUN_REPORT',
    'GOOGLEANALYTICS_LIST_PROPERTIES',
  ],
  // ── Productivity ──────────────────────────────────────────────────────────
  airtable: [
    'AIRTABLE_LIST_RECORDS',
    'AIRTABLE_GET_RECORD',
    'AIRTABLE_CREATE_RECORD',
    'AIRTABLE_UPDATE_RECORD',
    'AIRTABLE_DELETE_RECORD',
  ],
  calendly: [
    'CALENDLY_LIST_EVENTS',
    'CALENDLY_GET_EVENT',
    'CALENDLY_LIST_EVENT_TYPES',
    'CALENDLY_LIST_INVITEES',
  ],
  typeform: [
    'TYPEFORM_LIST_FORMS',
    'TYPEFORM_GET_FORM',
    'TYPEFORM_LIST_RESPONSES',
  ],
  surveymonkey: [
    'SURVEYMONKEY_LIST_SURVEYS',
    'SURVEYMONKEY_GET_SURVEY',
    'SURVEYMONKEY_LIST_RESPONSES',
  ],
  harvest: [
    'HARVEST_LIST_TIME_ENTRIES',
    'HARVEST_CREATE_TIME_ENTRY',
    'HARVEST_LIST_PROJECTS',
    'HARVEST_LIST_CLIENTS',
  ],
  toggl: [
    'TOGGL_LIST_TIME_ENTRIES',
    'TOGGL_CREATE_TIME_ENTRY',
    'TOGGL_STOP_TIME_ENTRY',
    'TOGGL_LIST_PROJECTS',
  ],
  clockify: [
    'CLOCKIFY_LIST_TIME_ENTRIES',
    'CLOCKIFY_CREATE_TIME_ENTRY',
    'CLOCKIFY_LIST_PROJECTS',
  ],
  // ── Design & Creative ─────────────────────────────────────────────────────
  figma: [
    'FIGMA_LIST_FILES',
    'FIGMA_GET_FILE',
    'FIGMA_LIST_COMMENTS',
    'FIGMA_POST_COMMENT',
    'FIGMA_GET_PROJECT_FILES',
  ],
  miro: [
    'MIRO_LIST_BOARDS',
    'MIRO_GET_BOARD',
    'MIRO_CREATE_CARD',
    'MIRO_CREATE_STICKY_NOTE',
  ],
  canva: [
    'CANVA_LIST_DESIGNS',
    'CANVA_GET_DESIGN',
  ],
  loom: [
    'LOOM_LIST_VIDEOS',
    'LOOM_GET_VIDEO',
  ],
  // ── Finance ───────────────────────────────────────────────────────────────
  stripe: [
    'STRIPE_CREATE_CUSTOMER',
    'STRIPE_LIST_CUSTOMERS',
    'STRIPE_GET_CUSTOMER',
    'STRIPE_LIST_INVOICES',
    'STRIPE_CREATE_PAYMENT_LINK',
  ],
  quickbooks: [
    'QUICKBOOKS_CREATE_INVOICE',
    'QUICKBOOKS_LIST_INVOICES',
    'QUICKBOOKS_GET_INVOICE',
    'QUICKBOOKS_LIST_CUSTOMERS',
    'QUICKBOOKS_CREATE_CUSTOMER',
  ],
  xero: [
    'XERO_CREATE_INVOICE',
    'XERO_LIST_INVOICES',
    'XERO_GET_INVOICE',
    'XERO_LIST_CONTACTS',
  ],
  brex: [
    'BREX_LIST_TRANSACTIONS',
    'BREX_LIST_CARDS',
    'BREX_LIST_BUDGETS',
  ],
  plaid: [
    'PLAID_LIST_ACCOUNTS',
    'PLAID_GET_TRANSACTIONS',
    'PLAID_GET_BALANCE',
  ],
  // ── HR & People ───────────────────────────────────────────────────────────
  bamboohr: [
    'BAMBOOHR_GET_EMPLOYEE',
    'BAMBOOHR_LIST_EMPLOYEES',
    'BAMBOOHR_LIST_TIME_OFF',
  ],
  gusto: [
    'GUSTO_LIST_EMPLOYEES',
    'GUSTO_GET_EMPLOYEE',
    'GUSTO_LIST_PAYROLLS',
  ],
  rippling: [
    'RIPPLING_LIST_EMPLOYEES',
    'RIPPLING_GET_EMPLOYEE',
  ],
  workday: [
    'WORKDAY_LIST_WORKERS',
    'WORKDAY_GET_WORKER',
  ],
  // ── E-commerce ────────────────────────────────────────────────────────────
  shopify: [
    'SHOPIFY_LIST_ORDERS',
    'SHOPIFY_GET_ORDER',
    'SHOPIFY_LIST_PRODUCTS',
    'SHOPIFY_GET_PRODUCT',
    'SHOPIFY_LIST_CUSTOMERS',
    'SHOPIFY_CREATE_ORDER',
  ],
  woocommerce: [
    'WOOCOMMERCE_LIST_ORDERS',
    'WOOCOMMERCE_GET_ORDER',
    'WOOCOMMERCE_LIST_PRODUCTS',
    'WOOCOMMERCE_GET_PRODUCT',
  ],
  // ── Social & Content ──────────────────────────────────────────────────────
  twitter: [
    'TWITTER_CREATE_TWEET',
    'TWITTER_GET_TWEET',
    'TWITTER_LIST_TWEETS',
    'TWITTER_SEARCH_TWEETS',
  ],
  linkedin: [
    'LINKEDIN_CREATE_POST',
    'LINKEDIN_GET_PROFILE',
    'LINKEDIN_LIST_CONNECTIONS',
  ],
  youtube: [
    'YOUTUBE_LIST_VIDEOS',
    'YOUTUBE_GET_VIDEO',
    'YOUTUBE_LIST_PLAYLISTS',
    'YOUTUBE_LIST_COMMENTS',
  ],
  reddit: [
    'REDDIT_GET_SUBREDDIT',
    'REDDIT_LIST_POSTS',
    'REDDIT_SUBMIT_POST',
    'REDDIT_SUBMIT_COMMENT',
  ],
  webflow: [
    'WEBFLOW_LIST_SITES',
    'WEBFLOW_LIST_COLLECTIONS',
    'WEBFLOW_LIST_ITEMS',
    'WEBFLOW_CREATE_ITEM',
    'WEBFLOW_UPDATE_ITEM',
  ],
  wordpress: [
    'WORDPRESS_LIST_POSTS',
    'WORDPRESS_GET_POST',
    'WORDPRESS_CREATE_POST',
    'WORDPRESS_UPDATE_POST',
  ],
  // ── Legal & Docs ──────────────────────────────────────────────────────────
  docusign: [
    'DOCUSIGN_CREATE_ENVELOPE',
    'DOCUSIGN_GET_ENVELOPE',
    'DOCUSIGN_LIST_ENVELOPES',
    'DOCUSIGN_SEND_ENVELOPE',
  ],
  pandadoc: [
    'PANDADOC_CREATE_DOCUMENT',
    'PANDADOC_GET_DOCUMENT',
    'PANDADOC_LIST_DOCUMENTS',
    'PANDADOC_SEND_DOCUMENT',
  ],
  // ── IT & Identity ─────────────────────────────────────────────────────────
  okta: [
    'OKTA_LIST_USERS',
    'OKTA_GET_USER',
    'OKTA_LIST_GROUPS',
    'OKTA_ADD_USER_TO_GROUP',
  ],
  servicenow: [
    'SERVICENOW_CREATE_INCIDENT',
    'SERVICENOW_UPDATE_INCIDENT',
    'SERVICENOW_GET_INCIDENT',
    'SERVICENOW_LIST_INCIDENTS',
  ],
  // ── Search & Data ─────────────────────────────────────────────────────────
  algolia: [
    'ALGOLIA_SEARCH',
    'ALGOLIA_LIST_INDICES',
    'ALGOLIA_SAVE_OBJECT',
  ],
  mongodb: [
    'MONGODB_FIND_DOCUMENTS',
    'MONGODB_INSERT_DOCUMENT',
    'MONGODB_UPDATE_DOCUMENT',
    'MONGODB_AGGREGATE',
  ],
  elasticsearch: [
    'ELASTICSEARCH_SEARCH',
    'ELASTICSEARCH_INDEX_DOCUMENT',
    'ELASTICSEARCH_GET_DOCUMENT',
  ],
  // ── Scheduling & Events ───────────────────────────────────────────────────
  eventbrite: [
    'EVENTBRITE_LIST_EVENTS',
    'EVENTBRITE_GET_EVENT',
    'EVENTBRITE_LIST_ATTENDEES',
  ],
  acuityscheduling: [
    'ACUITYSCHEDULING_LIST_APPOINTMENTS',
    'ACUITYSCHEDULING_GET_APPOINTMENT',
    'ACUITYSCHEDULING_CREATE_APPOINTMENT',
  ],
}

const ALLOWED_ACTIONS = new Set(Object.values(ALLOWED_ACTIONS_BY_APP).flat())

// Escape hatch: bypass the allowlist to see everything a tenant's connections
// expose. Useful when adding a connector and you need the real action slugs.
// Do not enable in production — it reinstates the full token cost.
function isAllowlistBypassed(): boolean {
  return process.env.COMPOSIO_ALLOWLIST_DISABLED === 'true'
}

// Tracks allowlist entries that never matched a real tool, so typos in the
// slugs above surface loudly instead of silently dropping a tool. Logged once
// per process per unmatched slug.
const warnedMissing = new Set<string>()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyAllowlist(tools: Record<string, any>, tenantId: string): Record<string, any> {
  const available = new Set(Object.keys(tools))

  const allowed = Object.fromEntries(
    Object.entries(tools).filter(([key]) => ALLOWED_ACTIONS.has(key))
  )

  const dropped = available.size - Object.keys(allowed).length
  if (dropped > 0) {
    console.log(
      `[composio] allowlist dropped ${dropped} of ${available.size} tools for tenant ${tenantId}`
    )
  }

  // An allowlisted action that isn't in the fetched map is either a slug typo
  // or an app this tenant hasn't connected. Only warn when at least one action
  // from the same app IS present — that narrows it to a likely typo.
  for (const [app, actions] of Object.entries(ALLOWED_ACTIONS_BY_APP)) {
    const appIsConnected = actions.some((a) => available.has(a))
    if (!appIsConnected) continue
    for (const action of actions) {
      if (available.has(action) || warnedMissing.has(action)) continue
      warnedMissing.add(action)
      console.warn(
        `[composio] allowlisted action ${action} not found in ${app} tools — check the slug`
      )
    }
  }

  return allowed
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getComposioTools(tenantId: string): Promise<Record<string, any>> {
  const cached = composioCache.get(tenantId)
  if (cached && cached.expiresAt > Date.now()) return cached.tools

  const toolset = getComposioToolSet()

  // filterByAvailableApps: true — only returns tools for apps this tenant has connected.
  // Prevents the agent seeing tool stubs for unconnected apps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fetched: Record<string, any> = await toolset.getTools(
    { filterByAvailableApps: true },
    tenantId,
  )

  // Second gate: narrow the tenant's connected apps down to curated actions.
  // Filtering here rather than via getTools({ actions }) keeps the behaviour
  // independent of SDK filter precedence and lets us report what was dropped.
  const tools = isAllowlistBypassed() ? fetched : applyAllowlist(fetched, tenantId)

  composioCache.set(tenantId, { tools, expiresAt: Date.now() + CACHE_TTL_MS })
  console.log(`[composio] fetched ${Object.keys(tools).length} tools for tenant ${tenantId}`)
  return tools
}

export function invalidateComposioCache(tenantId: string): void {
  composioCache.delete(tenantId)
}
