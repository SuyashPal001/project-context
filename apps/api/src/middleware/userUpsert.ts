import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { users } from '@serverless-saas/database/schema/auth';

// name-slug + 8 random alphanumeric chars → e.g. "harbhajan-singh-a1b2c3d4"
// 36^8 ≈ 2.8T possibilities — collision negligible even at millions of users.
function generatePersonalIdentifier(name: string): string {
    const slug = (name || 'user')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30)
    const suffix = Math.random().toString(36).slice(2, 10)
    return `${slug || 'user'}-${suffix}`
}

async function upsertUser(
    cognitoId: string,
    email: string,
    name: string,
    attempt = 0
): Promise<typeof users.$inferSelect> {
    const personalIdentifier = generatePersonalIdentifier(name || email)
    try {
        const [user] = await db.insert(users)
            .values({ cognitoId, email, name, personalIdentifier })
            .onConflictDoUpdate({
                target: users.cognitoId,
                // personalIdentifier intentionally excluded — keeps existing value on update
                set: { email, name, updatedAt: new Date() },
            })
            .returning()
        return user
    } catch (err: any) {
        if (err?.code === '23505' && err?.constraint === 'users_personal_identifier_unique' && attempt < 3) {
            return upsertUser(cognitoId, email, name, attempt + 1)
        }
        throw err
    }
}

/**
 * User Upsert Middleware — Volca Pattern (ADR-024)
 *
 * Runs on every authenticated API request.
 * Creates the user in our DB if they don't exist yet,
 * or updates their email/name if they changed it (e.g. Google profile update).
 *
 * This replaces the Post Confirmation Lambda trigger — one place handles
 * all signup methods (email/password, Google OAuth, invite flow).
 *
 * Attaches userId to context so downstream middleware can use it.
 */
export const userUpsertMiddleware = async (c: Context, next: Next) => {
    const jwtPayload = c.get('jwtPayload');

    // Skip upsert if no JWT payload (e.g. API key request or non-authenticated)
    if (!jwtPayload) {
        return next();
    }

    const cognitoId = jwtPayload.sub;
    const email = jwtPayload.email as string;
    const name = jwtPayload.name as string | undefined;

    console.log('UPSERT CLAIMS:', JSON.stringify({
        cognitoId, email, name,
        allKeys: Object.keys(jwtPayload)
    }));

    if (!cognitoId) {
        console.log('401 reason: invalid jwt payload', { path: c.req.path, hasCognitoId: !!cognitoId, hasEmail: !!email });
        return c.json({ error: 'Invalid JWT payload' }, 401);
    }

    // Access Tokens (used by the relay when calling internal endpoints) do not carry
    // an email claim — only ID Tokens do. In that case, the user must already exist;
    // skip the upsert and look them up by cognitoId.
    if (!email) {
        const [existingUser] = await db
            .select()
            .from(users)
            .where(eq(users.cognitoId, cognitoId))
            .limit(1);

        if (!existingUser) {
            console.log('401 reason: no email claim and user not found', { cognitoId });
            return c.json({ error: 'User not found' }, 401);
        }

        c.set('userId', existingUser.id);
        return next();
    }

    try {
        const user = await upsertUser(cognitoId, email, name || "")
        c.set('userId', user.id);
    } catch (error: any) {
        if (error?.code === '23505' && error?.constraint === 'users_email_unique') {
            // Same email, different cognitoId — user switched auth method (e.g., email → Google OAuth)
            // Update the existing row to point to the new cognitoId
            const [user] = await db.update(users)
                .set({ cognitoId, name: name || "", updatedAt: new Date() })
                .where(eq(users.email, email))
                .returning();
            c.set('userId', user.id);
        } else {
            throw error;
        }
    }

    await next();
};