import { relations } from 'drizzle-orm';
import { users } from './auth';
import { memberships, tenants } from './tenancy';
import { roles } from './authorization';

export const membershipsRelations = relations(memberships, ({ one }) => ({
    user: one(users, {
        fields: [memberships.userId],
        references: [users.id],
    }),
    role: one(roles, {
        fields: [memberships.roleId],
        references: [roles.id],
    }),
    tenant: one(tenants, {
        fields: [memberships.tenantId],
        references: [tenants.id],
    }),
}));
