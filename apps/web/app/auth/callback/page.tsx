"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useHyperspace } from "@/components/hyperspace-provider";
import { useRouter } from "next/navigation";

function CallbackContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { startHyperspace, finishHyperspace } = useHyperspace();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get("code");

    if (!code) {
      setError("No authorization code found in the URL.");
      return;
    }

    async function exchangeCode() {
      try {
        const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
        const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID;
        const callbackUrl = process.env.NEXT_PUBLIC_COGNITO_CALLBACK_URL;

        // 1. Exchange code for tokens
        const tokenResponse = await fetch(`${domain}/oauth2/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId!,
            redirect_uri: callbackUrl!,
            code: code ?? "",
          }),
        });

        if (!tokenResponse.ok) {
          const errData = await tokenResponse.json();
          throw new Error(errData.error_description || errData.error || "Failed to exchange code for tokens");
        }

        const tokens = await tokenResponse.json();
        const idToken = tokens.id_token;
        const accessToken = tokens.access_token;

        // 2. Create session — sets platform_token httpOnly cookie
        const sessionResponse = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: idToken,
            accessToken,
            refreshToken: tokens.refresh_token
          }),
        });

        if (!sessionResponse.ok) {
          throw new Error("Failed to create session on the server");
        }

        // 3. Check for invite redirect in sessionStorage
        const authRedirect = sessionStorage.getItem("auth_redirect");
        if (authRedirect) {
          sessionStorage.removeItem("auth_redirect");

          if (authRedirect.startsWith("/auth/invite/")) {
            const token = authRedirect.split("/").pop();
            if (token) {
              try {
                const acceptRes = await fetch(`/api/proxy/api/v1/invitations/${token}/accept`, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${idToken}`,
                  },
                });

                const acceptData = await acceptRes.json();

                if (acceptRes.ok) {
                  // Global loader will finish when the dashboard layout mounts
                  router.push(`/${acceptData.tenantSlug}/dashboard`);
                  router.refresh();
                  return;
                } else {
                  window.location.href = `/auth/invite/${token}?error=${acceptData.code || "ACCEPT_FAILED"}`;
                  return;
                }
              } catch (err) {
                console.error("Failed to accept invite after OAuth:", err);
                window.location.href = `/auth/invite/${token}?error=ACCEPT_FAILED`;
                return;
              }
            }
          }
        }

        // 4. Fetch user profile to get slug and onboarding status
        const profileRes = await fetch(`/api/proxy/api/v1/auth/me`, {
          headers: {
            Authorization: `Bearer ${idToken}`,
          },
        });
        if (!profileRes.ok) throw new Error("Failed to fetch user profile");
        const profile = await profileRes.json();

        // 5. Route based on role and onboarding status.
        // Hyperspace only fires for returning users — new users go to onboarding silently.
        if (profile.role === 'platform_admin') {
          router.push('/ops');
          router.refresh();
        } else if (profile.slug && !profile.needsOnboarding) {
          startHyperspace('signin');
          router.push(`/${profile.slug}/dashboard`);
          router.refresh();
        } else {
          router.push("/auth/onboarding");
          router.refresh();
        }
      } catch (err: any) {
        console.error("Auth callback error:", err);
        finishHyperspace();
        setError(err.message || "An error occurred during authentication.");
      }
    }

    exchangeCode();
  }, [searchParams]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-4 text-center">
        <h1 className="text-2xl font-bold text-destructive mb-4">Authentication Error</h1>
        <p className="text-muted-foreground mb-6">{error}</p>
        <a href="/auth/login" className="text-primary hover:underline font-medium">
          Back to login
        </a>
      </div>
    );
  }

  return (
    <div className="bg-black min-h-screen" />
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={
      <div className="flex flex-col items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
        <p className="text-muted-foreground">Loading...</p>
      </div>
    }>
      <CallbackContent />
    </Suspense>
  );
}
