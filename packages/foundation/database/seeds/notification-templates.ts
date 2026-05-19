import { eq, and, isNull } from 'drizzle-orm';
import { notificationTemplates } from '../schema/notifications';
import { users } from '../schema/auth';


import type { db as DB } from './index';

const TEMPLATES: Array<{
    name: string;
    channel: 'email' | 'in_app';
    subject?: string;
    body: string;
}> = [
        {
            name: 'user.invited',
            channel: 'email',
            subject: 'You\'ve been invited to {{tenantName}}',
            body: '<p>Hi there,</p><p><strong>{{inviterName}}</strong> has invited you to join <strong>{{tenantName}}</strong>.</p><p><a href="{{inviteLink}}">Click here to accept your invitation</a></p><p>This invitation expires in 7 days.</p>',
        },
        {
            name: 'user.invited',
            channel: 'in_app',
            subject: 'Team Invitation',
            body: '{{inviterName}} invited you to join {{tenantName}}',
        },
        {
            name: 'invoice.failed',
            channel: 'email',
            subject: 'Payment failed for {{tenantName}}',
            body: '<p>Hi there,</p><p>A payment of <strong>{{amount}}</strong> for <strong>{{tenantName}}</strong> has failed.</p><p>Please update your billing information to avoid service interruption. We will retry the payment automatically.</p>',
        },
        {
            name: 'invoice.failed',
            channel: 'in_app',
            subject: 'Payment Failed',
            body: 'Payment of {{amount}} failed. Please update your billing information.',
        },
        {
            name: 'subscription.upgraded',
            channel: 'in_app',
            subject: 'Plan Upgraded',
            body: 'Your plan has been upgraded to {{plan}}',
        },
        {
            name: 'subscription.cancelled',
            channel: 'email',
            subject: 'Subscription cancelled for {{tenantName}}',
            body: '<p>Hi there,</p><p>Your subscription for <strong>{{tenantName}}</strong> has been cancelled.</p><p>You will continue to have access until <strong>{{endDate}}</strong>.</p>',
        },
        {
            name: 'usage.limit_approaching',
            channel: 'in_app',
            subject: 'Usage Warning',
            body: 'You\'ve used {{percentage}}% of your {{feature}} limit',
        },
        {
            name: 'usage.limit_reached',
            channel: 'email',
            subject: '{{feature}} limit reached',
            body: '<p>You\'ve reached your <strong>{{feature}}</strong> limit of <strong>{{limit}}</strong>.</p><p>Upgrade your plan to continue using this feature without interruption.</p>',
        },
        {
            name: 'usage.limit_reached',
            channel: 'in_app',
            subject: 'Limit Reached',
            body: 'You\'ve reached your {{feature}} limit. Upgrade to continue.',
        },
        {
            name: 'agent.approval_required',
            channel: 'in_app',
            subject: 'Approval Required',
            body: 'Agent {{agentName}} needs your approval for {{action}}',
        },
        {
            name: 'security.cross_tenant_attempt',
            channel: 'in_app',
            subject: 'Security Alert',
            body: 'A cross-tenant access attempt was blocked',
        },
        {
            name: 'task.awaiting_approval',
            channel: 'in_app',
            subject: 'Plan ready for review',
            body: 'Saarthi has finished planning {{taskTitle}}. Review and approve the plan.',
        },
        {
            name: 'task.completed',
            channel: 'in_app',
            subject: 'Task complete',
            body: 'Saarthi has completed {{taskTitle}}. Review the results.',
        },
        {
            name: 'task.needs_clarification',
            channel: 'in_app',
            subject: 'Saarthi needs clarification',
            body: 'Saarthi has a question before continuing with {{taskTitle}}.',
        },
        {
            name: 'task.failed',
            channel: 'in_app',
            subject: 'Task failed',
            body: 'Saarthi encountered an error while working on {{taskTitle}}.',
        },
        {
            name: 'prd.created',
            channel: 'in_app',
            subject: 'PRD ready for review',
            body: 'Saarthi has finished writing the PRD for {{artifactTitle}}. Open chat to review and approve.',
        },
        {
            name: 'roadmap.created',
            channel: 'in_app',
            subject: 'Roadmap ready for review',
            body: 'Saarthi has created a roadmap for {{artifactTitle}}. Open chat to review and approve.',
        },
        {
            name: 'tasks.created',
            channel: 'in_app',
            subject: 'Tasks ready for review',
            body: 'Saarthi has broken down {{artifactTitle}} into tasks. Open chat to review and confirm.',
        },
    ];

export async function seedNotificationTemplates(db: typeof DB) {
    console.log('Seeding notification templates...');

    const [firstUser] = await db.select({ id: users.id }).from(users).limit(1);
    if (!firstUser) {
        console.log('  skipped — no users in DB, run after first user is created');
        return;
    }

    let created = 0;
    let skipped = 0;

    for (const template of TEMPLATES) {
        const existing = await db
            .select({ id: notificationTemplates.id })
            .from(notificationTemplates)
            .where(and(
                eq(notificationTemplates.name, template.name),
                eq(notificationTemplates.channel, template.channel),
                isNull(notificationTemplates.tenantId),
            ))
            .limit(1);

        if (existing.length > 0) {
            skipped++;
            continue;
        }

        await db.insert(notificationTemplates).values({
            tenantId: null,
            name: template.name,
            channel: template.channel,
            subject: template.subject ?? null,
            body: template.body,
            createdBy: firstUser.id,
        });
        created++;
    }

    console.log(`  inserted ${created}, skipped ${skipped}`);
}
