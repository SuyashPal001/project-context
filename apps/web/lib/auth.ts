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

export async function signIn(email: string, password: string) {
    const data = await cognitoRequest('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: {
            USERNAME: email,
            PASSWORD: password,
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
        window.location.href = '/auth/login';
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