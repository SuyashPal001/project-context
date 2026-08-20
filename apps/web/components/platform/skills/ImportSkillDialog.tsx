"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { createSkillFromZip, createSkillFromGithub, createSkillFromUrl } from "./actions";

interface ImportSkillDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onImported: () => void;
}

export function ImportSkillDialog({ open, onOpenChange, onImported }: ImportSkillDialogProps) {
    const [source, setSource] = useState<"zip" | "github" | "url">("zip");
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [file, setFile] = useState<File | null>(null);
    const [owner, setOwner] = useState("");
    const [repo, setRepo] = useState("");
    const [ref, setRef] = useState("main");
    const [url, setUrl] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reset = () => {
        setName(""); setDescription(""); setFile(null); setOwner(""); setRepo(""); setRef("main"); setUrl(""); setError(null);
    };

    const handleSubmit = async () => {
        if (!name.trim()) { setError("Name is required"); return; }
        setSubmitting(true);
        setError(null);
        try {
            if (source === "zip") {
                if (!file) { setError("Choose a zip file"); setSubmitting(false); return; }
                await createSkillFromZip(name, description, file);
            } else if (source === "github") {
                if (!owner.trim() || !repo.trim()) { setError("Owner and repo are required"); setSubmitting(false); return; }
                await createSkillFromGithub(name, description, owner.trim(), repo.trim(), ref.trim() || "main");
            } else {
                if (!url.trim()) { setError("URL is required"); setSubmitting(false); return; }
                await createSkillFromUrl(name, description, url.trim());
            }
            reset();
            onOpenChange(false);
            onImported();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Import failed");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Import a skill</DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                    <Input placeholder="Skill name" value={name} onChange={(e) => setName(e.target.value)} />
                    <Textarea placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />

                    <Tabs value={source} onValueChange={(v) => setSource(v as typeof source)}>
                        <TabsList>
                            <TabsTrigger value="zip">Upload zip</TabsTrigger>
                            <TabsTrigger value="github">GitHub repo</TabsTrigger>
                            <TabsTrigger value="url">Paste URL</TabsTrigger>
                        </TabsList>
                        <TabsContent value="zip">
                            <Input type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                        </TabsContent>
                        <TabsContent value="github" className="space-y-2">
                            <p className="text-xs text-muted-foreground">Public repositories only.</p>
                            <Input placeholder="Owner (e.g. anthropics)" value={owner} onChange={(e) => setOwner(e.target.value)} />
                            <Input placeholder="Repo (e.g. skills)" value={repo} onChange={(e) => setRepo(e.target.value)} />
                            <Input placeholder="Branch or tag (default: main)" value={ref} onChange={(e) => setRef(e.target.value)} />
                        </TabsContent>
                        <TabsContent value="url">
                            <Input placeholder="https://example.com/my-skill.zip" value={url} onChange={(e) => setUrl(e.target.value)} />
                        </TabsContent>
                    </Tabs>

                    {error && <p className="text-xs text-destructive">{error}</p>}

                    <Button onClick={handleSubmit} disabled={submitting} className="w-full">
                        {submitting ? "Importing…" : "Import"}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
