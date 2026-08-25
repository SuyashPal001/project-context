/** The name to greet a signed-in user by, from their ID token claims.
 *
 *  `platform_token` is the Cognito ID token, so a Google-federated login
 *  carries given_name and name; a plain email signup may carry neither, and
 *  the greeting reads "Hi {name}!" — an empty result would render "Hi !".
 *  Hence the chain down to a generic "there".
 */
export function greetingName(claims: Record<string, unknown>): string {
    const given = typeof claims.given_name === 'string' ? claims.given_name.trim() : '';
    if (given) return given;

    const full = typeof claims.name === 'string' ? claims.name.trim() : '';
    if (full) return full.split(/\s+/)[0];

    const email = typeof claims.email === 'string' ? claims.email.trim() : '';
    // "john.doe@x" greets "John", not "John.doe" — the local part is an
    // address, not a name, so only the leading segment is usable.
    const local = email.split('@')[0]?.split(/[._+\-0-9]/)[0] ?? '';
    if (local) return local.charAt(0).toUpperCase() + local.slice(1);

    return 'there';
}
