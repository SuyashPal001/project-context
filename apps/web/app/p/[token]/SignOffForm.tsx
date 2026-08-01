'use client';

import { useState } from 'react';

export function SignOffForm({ token, signedByName }: { token: string; signedByName: string | null }) {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [done, setDone] = useState(Boolean(signedByName));
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    if (done) {
        return (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-8 text-center">
                <p className="text-lg font-semibold">Project closed</p>
                <p className="mt-1 text-sm text-muted-foreground">Signed by {signedByName ?? name}</p>
            </div>
        );
    }

    async function submit() {
        if (!name.trim() || !email.trim() || saving) return;
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`/api/portal/${token}/sign`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), email: email.trim() }),
            });
            if (!res.ok) throw new Error((await res.json())?.error ?? 'Could not sign');
            setDone(true);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <div className="rounded-xl border border-border p-6">
            <p className="mb-4 text-sm text-muted-foreground">
                Confirm you have received this handover and accept the support terms above.
            </p>
            <div className="space-y-3">
                <input
                    className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm"
                    placeholder="Your full name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <input
                    className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm"
                    placeholder="Your email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                />
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <button
                    type="button"
                    onClick={submit}
                    disabled={!name.trim() || !email.trim() || saving}
                    className="w-full rounded-lg bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-500 disabled:opacity-40"
                >
                    {saving ? 'Signing…' : 'Review & sign'}
                </button>
            </div>
        </div>
    );
}
