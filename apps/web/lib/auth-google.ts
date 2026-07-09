export function initiateGoogleSignIn(redirectTo?: string): void {
  const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN!;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID!;
  const callbackUrl = process.env.NEXT_PUBLIC_COGNITO_CALLBACK_URL!;

  if (redirectTo) {
    sessionStorage.setItem("auth_redirect", redirectTo);
  } else {
    sessionStorage.removeItem("auth_redirect");
  }

  // Signal the callback page to start Google OAuth after the logout completes.
  sessionStorage.setItem("google_signin_pending", "1");

  // Clear the Cognito session first so Google always shows the account picker.
  // Cognito redirects to callbackUrl after logout; the callback page detects the
  // google_signin_pending flag and kicks off the Google OAuth authorize redirect.
  const logoutUrl = `${domain}/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(callbackUrl)}`;
  window.location.href = logoutUrl;
}

export function buildGoogleAuthorizeUrl(): string {
  const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN!;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID!;
  const callbackUrl = process.env.NEXT_PUBLIC_COGNITO_CALLBACK_URL!;
  return `${domain}/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&identity_provider=Google&scope=openid%20email%20profile&prompt=select_account`;
}
