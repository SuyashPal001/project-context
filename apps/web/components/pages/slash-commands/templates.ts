export interface SlashTemplate {
    title: string
    description: string
    pageType: string
    html: string
}

export const SLASH_TEMPLATES: SlashTemplate[] = [
    {
        title: 'PRD Structure',
        description: 'Product requirements template',
        pageType: 'prd',
        html: `<h2>Problem Statement</h2><p></p><h2>Goals &amp; Success Metrics</h2><p></p><h2>User Stories</h2><p></p><h2>Out of Scope</h2><p></p><h2>Open Questions</h2><p></p>`,
    },
    {
        title: 'ADR Structure',
        description: 'Architecture decision record',
        pageType: 'adr',
        html: `<h2>Status</h2><p>Proposed</p><h2>Context</h2><p></p><h2>Decision</h2><p></p><h2>Consequences</h2><p></p>`,
    },
    {
        title: 'Runbook Structure',
        description: 'Operational runbook template',
        pageType: 'runbook',
        html: `<h2>Overview</h2><p></p><h2>Prerequisites</h2><p></p><h2>Steps</h2><ol><li><p></p></li></ol><h2>Rollback</h2><p></p><h2>Contacts</h2><p></p>`,
    },
    {
        title: 'Handover Structure',
        description: 'Project handover document',
        pageType: 'handover',
        html: `<h2>Project Summary</h2><p></p><h2>Architecture Overview</h2><p></p><h2>Known Issues</h2><p></p><h2>Credentials &amp; Access</h2><p></p><h2>Next Steps</h2><p></p>`,
    },
]
