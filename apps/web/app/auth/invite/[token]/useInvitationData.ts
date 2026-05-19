"use client";

import { useEffect, useState } from "react";
import type { InviteDetails, UserProfile } from "./_schemas";

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
    EXPIRED: "This invitation has expired.",
    REVOKED: "This invitation has been revoked.",
    ALREADY_ACCEPTED: "This invitation has already been accepted.",
    ACCEPT_FAILED: "Failed to accept invitation. Please try again.",
};

export interface InvitationDataState {
    invite: InviteDetails | null;
    user: UserProfile | null;
    emailExists: boolean | null;
    error: string | null;
    isLoading: boolean;
    isCheckingEmail: boolean;
}

export function useInvitationData(token: string, errorCode: string | null) {
    const [invite, setInvite] = useState<InviteDetails | null>(null);
    const [user, setUser] = useState<UserProfile | null>(null);
    const [emailExists, setEmailExists] = useState<boolean | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isCheckingEmail, setIsCheckingEmail] = useState(false);

    useEffect(() => {
        async function fetchData() {
            try {
                // 1. Fetch invite details
                const inviteRes = await fetch(`/api/proxy/api/v1/invitations/${token}`);
                if (!inviteRes.ok) {
                    const data = await inviteRes.json();
                    throw new Error(data.error || "Invalid or expired invitation");
                }
                const inviteData: InviteDetails = await inviteRes.json();
                setInvite(inviteData);

                // 2. Check if invited email has an existing account
                setIsCheckingEmail(true);
                try {
                    const checkEmailRes = await fetch(`/api/proxy/api/v1/auth/check-email?email=${encodeURIComponent(inviteData.email)}`);
                    if (checkEmailRes.ok) {
                        const checkData = await checkEmailRes.json();
                        setEmailExists(checkData.exists);
                    }
                } catch (e) {
                    console.error("Failed to check email existence:", e);
                } finally {
                    setIsCheckingEmail(false);
                }

                // 3. Fetch auth status
                let profileData: UserProfile | null = null;
                const profileRes = await fetch("/api/proxy/api/v1/auth/me");
                if (profileRes.ok) {
                    profileData = await profileRes.json();
                    setUser(profileData);
                }

                // 4. Handle OAuth callback errors
                if (errorCode) {
                    if (errorCode === "EMAIL_MISMATCH") {
                        const currentEmail = profileData?.email ? ` as ${profileData.email}` : "";
                        setError(`You're signed in${currentEmail} but this invite was sent to ${inviteData.email}. Please sign out and sign in with the correct account.`);
                    } else {
                        setError(OAUTH_ERROR_MESSAGES[errorCode] ?? "An error occurred while processing your invitation.");
                    }
                }
            } catch (err) {
                console.error("Fetch Error:", err);
                if (!errorCode) {
                    const msg = err instanceof Error ? err.message : "Failed to load invitation details";
                    setError(msg);
                }
            } finally {
                setIsLoading(false);
            }
        }

        if (token) {
            fetchData();
        }
    }, [token, errorCode]);

    return { invite, user, emailExists, error, isLoading, isCheckingEmail, setError };
}
