const COGNITO_ENDPOINT = `https://cognito-idp.ap-south-1.amazonaws.com/`;
const CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID!;

async function cognitoRequest(target: string, body: object) {
    const res = await fetch(COGNITO_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
        },
        body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.__type || 'Cognito request failed');
    return data;
}

export type SignInResult =
    | { challenge?: undefined; idToken: string; accessToken: string; refreshToken: string }
    | { challenge: 'NEW_PASSWORD_REQUIRED'; session: string };

export async function signIn(email: string, password: string): Promise<SignInResult> {
    const data = await cognitoRequest('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: {
            USERNAME: email,
            PASSWORD: password,
        },
    });

    // Cognito returns a challenge instead of tokens when the account has a
    // temporary/admin-set password still pending a user-chosen replacement
    // (e.g. accounts created via admin-create-user). No AuthenticationResult
    // exists yet in this case — the caller must complete the challenge first.
    if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        return { challenge: 'NEW_PASSWORD_REQUIRED', session: data.Session };
    }

    return {
        idToken: data.AuthenticationResult.IdToken,
        accessToken: data.AuthenticationResult.AccessToken,
        refreshToken: data.AuthenticationResult.RefreshToken,
    };
}

export async function completeNewPasswordChallenge(email: string, newPassword: string, session: string) {
    const data = await cognitoRequest('RespondToAuthChallenge', {
        ClientId: CLIENT_ID,
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        Session: session,
        ChallengeResponses: {
            USERNAME: email,
            NEW_PASSWORD: newPassword,
        },
    });

    return {
        idToken: data.AuthenticationResult.IdToken,
        accessToken: data.AuthenticationResult.AccessToken,
        refreshToken: data.AuthenticationResult.RefreshToken,
    };
}

export async function refreshSession(refreshToken: string, clientMetadata?: Record<string, string>) {
    const body: Record<string, unknown> = {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: {
            REFRESH_TOKEN: refreshToken,
        },
    };
    if (clientMetadata) body.ClientMetadata = clientMetadata;

    const data = await cognitoRequest('InitiateAuth', body);
    return {
        idToken: data.AuthenticationResult.IdToken,
        accessToken: data.AuthenticationResult.AccessToken,
    };
}

export async function signOut() {
    if (typeof window !== 'undefined') {
        try {
            await fetch('/api/proxy/api/v1/auth/logout', { method: 'POST' });
        } catch (e) {
            console.error('Failed to invalidate session on backend', e);
        }
        try {
            await fetch('/api/auth/session', { method: 'DELETE' });
        } catch (e) {
            console.error('Failed to clear session cookie', e);
        }

        // End the Cognito hosted UI session too — otherwise Google OAuth users
        // are silently re-logged-in on the next "Sign in with Google" click.
        const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
        const logoutUrl = process.env.NEXT_PUBLIC_COGNITO_LOGOUT_URL;
        if (domain && logoutUrl) {
            window.location.href = `${domain}/logout?client_id=${CLIENT_ID}&logout_uri=${encodeURIComponent(logoutUrl)}`;
        } else {
            window.location.href = '/auth/login';
        }
    }
}

export async function signUp(name: string, email: string, password: string) {
    const data = await cognitoRequest('SignUp', {
        ClientId: CLIENT_ID,
        Username: email,
        Password: password,
        UserAttributes: [{ Name: 'name', Value: name }],
    });
    return data;
}

export async function confirmSignUp(email: string, code: string) {
    await cognitoRequest('ConfirmSignUp', {
        ClientId: CLIENT_ID,
        Username: email,
        ConfirmationCode: code,
    });
}

export async function resendConfirmationCode(email: string) {
    await cognitoRequest('ResendConfirmationCode', {
        ClientId: CLIENT_ID,
        Username: email,
    });
}

export async function forgotPassword(email: string) {
    await cognitoRequest('ForgotPassword', {
        ClientId: CLIENT_ID,
        Username: email,
    });
}

export async function resetPassword(email: string, code: string, newPassword: string) {
    await cognitoRequest('ConfirmForgotPassword', {
        ClientId: CLIENT_ID,
        Username: email,
        ConfirmationCode: code,
        Password: newPassword,
    });
}