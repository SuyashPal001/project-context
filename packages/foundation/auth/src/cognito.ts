import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  ListUsersCommand,
  type AdminCreateUserCommandInput,
  type AdminInitiateAuthCommandInput,
} from '@aws-sdk/client-cognito-identity-provider';

export type AuthProvider = 'email' | 'google' | 'not_found';

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  clientSecret?: string;
}

let client: CognitoIdentityProviderClient | null = null;
let config: CognitoConfig | null = null;

export const initCognito = (cfg: CognitoConfig): void => {
  config = cfg;
  client = new CognitoIdentityProviderClient({ region: cfg.region });
};

export const getCognitoClient = (): CognitoIdentityProviderClient => {
  if (!client) {
    throw new Error('Cognito not initialized. Call initCognito() first.');
  }
  return client;
};

export const getCognitoConfig = (): CognitoConfig => {
  if (!config) {
    throw new Error('Cognito not initialized. Call initCognito() first.');
  }
  return config;
};

export const createUser = async (opts: {
  email: string;
  name: string;
  temporaryPassword?: string;
}): Promise<string> => {
  const cfg = getCognitoConfig();
  const input: AdminCreateUserCommandInput = {
    UserPoolId: cfg.userPoolId,
    Username: opts.email,
    UserAttributes: [
      { Name: 'email', Value: opts.email },
      { Name: 'email_verified', Value: 'true' },
      { Name: 'name', Value: opts.name },
    ],
    MessageAction: 'SUPPRESS',
  };

  if (opts.temporaryPassword) {
    input.TemporaryPassword = opts.temporaryPassword;
  }

  const result = await getCognitoClient().send(new AdminCreateUserCommand(input));
  const sub = result.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  if (!sub) throw new Error('Cognito user created but no sub returned');
  return sub;
};

export const setUserPassword = async (email: string, password: string): Promise<void> => {
  const cfg = getCognitoConfig();
  await getCognitoClient().send(
    new AdminSetUserPasswordCommand({
      UserPoolId: cfg.userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
};

export const disableUser = async (email: string): Promise<void> => {
  const cfg = getCognitoConfig();
  await getCognitoClient().send(
    new AdminDisableUserCommand({
      UserPoolId: cfg.userPoolId,
      Username: email,
    }),
  );
};

export const enableUser = async (email: string): Promise<void> => {
  const cfg = getCognitoConfig();
  await getCognitoClient().send(
    new AdminEnableUserCommand({
      UserPoolId: cfg.userPoolId,
      Username: email,
    }),
  );
};

export const deleteUser = async (email: string): Promise<void> => {
  const cfg = getCognitoConfig();
  await getCognitoClient().send(
    new AdminDeleteUserCommand({
      UserPoolId: cfg.userPoolId,
      Username: email,
    }),
  );
};

export const getUser = async (email: string) => {
  const cfg = getCognitoConfig();
  return getCognitoClient().send(
    new AdminGetUserCommand({
      UserPoolId: cfg.userPoolId,
      Username: email,
    }),
  );
};

export const adminInitiateAuth = async (email: string, password: string) => {
  const cfg = getCognitoConfig();
  const input: AdminInitiateAuthCommandInput = {
    UserPoolId: cfg.userPoolId,
    ClientId: cfg.clientId,
    AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    AuthParameters: {
      USERNAME: email,
      PASSWORD: password,
    },
  };

  if (cfg.clientSecret) {
    const { createHmac } = await import('crypto');
    const secretHash = createHmac('SHA256', cfg.clientSecret)
      .update(email + cfg.clientId)
      .digest('base64');
    input.AuthParameters!.SECRET_HASH = secretHash;
  }

  return getCognitoClient().send(new AdminInitiateAuthCommand(input));
};

export const respondToAuthChallenge = async (
  challengeName: string,
  session: string,
  responses: Record<string, string>,
) => {
  const cfg = getCognitoConfig();
  return getCognitoClient().send(
    new AdminRespondToAuthChallengeCommand({
      UserPoolId: cfg.userPoolId,
      ClientId: cfg.clientId,
      ChallengeName: challengeName as 'NEW_PASSWORD_REQUIRED',
      Session: session,
      ChallengeResponses: responses,
    }),
  );
};

export const getUserProvider = async (email: string): Promise<AuthProvider> => {
  const cfg = getCognitoConfig();
  const result = await getCognitoClient().send(
    new ListUsersCommand({
      UserPoolId: cfg.userPoolId,
      Filter: `email = "${email}"`,
      Limit: 5,
    }),
  );

  if (!result.Users || result.Users.length === 0) return 'not_found';

  for (const user of result.Users) {
    const identitiesAttr = user.Attributes?.find((a) => a.Name === 'identities');
    if (identitiesAttr?.Value) {
      const identities = JSON.parse(identitiesAttr.Value) as { providerName: string }[];
      if (identities.some((i) => i.providerName === 'Google')) return 'google';
    }
  }

  return 'email';
};

export const resetCognito = (): void => {
  client = null;
  config = null;
};
