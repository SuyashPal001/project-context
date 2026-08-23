"use client";

import { useRef, useState } from "react";
import { Upload, Github, Link2, CheckCircle2, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createSkillFromZip, createSkillFromGithub, createSkillFromUrl } from "./actions";

const SOURCE_HINT: Record<"zip" | "github" | "url", string> = {
    zip: "Have the skill's files on your computer? Upload them as a .zip.",
    github: "Import straight from a public GitHub repository — no download needed.",
    url: "Already have a direct download link to a .zip file? Paste it here.",
};

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
    const [isDraggingFile, setIsDraggingFile] = useState(false);
    // dragenter/dragleave fire on every child element as the pointer crosses
    // them, so a plain boolean flickers the overlay off while dragging over
    // nested elements — a depth counter only reaches zero when the pointer
    // truly leaves the drop zone.
    const dragDepthRef = useRef(0);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const reset = () => {
        setName(""); setDescription(""); setFile(null); setOwner(""); setRepo(""); setRef("main"); setUrl(""); setError(null);
    };

    const acceptFile = (candidate: File) => {
        if (!candidate.name.toLowerCase().endsWith(".zip")) {
            setError("Only .zip files are supported");
            return;
        }
        setError(null);
        setFile(candidate);
    };

    const formatFileSize = (bytes: number): string => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const handleDragEnter = (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setIsDraggingFile(true);
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDraggingFile(false);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        dragDepthRef.current = 0;
        setIsDraggingFile(false);

        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;
        if (files.length > 1) {
            setError("Drop one file at a time");
            return;
        }
        acceptFile(files[0]);
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
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Import a skill</DialogTitle>
                </DialogHeader>

                <div className="space-y-3">
                    <Tabs value={source} onValueChange={(v) => setSource(v as typeof source)}>
                        <TabsList className="w-full grid grid-cols-3">
                            <TabsTrigger value="zip">
                                <Upload className="h-3.5 w-3.5" />
                                Upload zip
                            </TabsTrigger>
                            <TabsTrigger value="github">
                                <Github className="h-3.5 w-3.5" />
                                GitHub repo
                            </TabsTrigger>
                            <TabsTrigger value="url">
                                <Link2 className="h-3.5 w-3.5" />
                                Paste URL
                            </TabsTrigger>
                        </TabsList>

                        <p className="text-xs text-muted-foreground mt-2">{SOURCE_HINT[source]}</p>
                    </Tabs>

                    <Input placeholder="Skill name" value={name} onChange={(e) => setName(e.target.value)} />
                    <Textarea placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />

                    <div className="min-h-[168px]">
                        {source === "zip" && (
                            <div
                                className={cn(
                                    "relative rounded-lg border border-dashed p-4 transition-colors",
                                    isDraggingFile ? "border-primary/60 bg-primary/5" : file ? "border-emerald-500/40 bg-emerald-500/5" : "border-border"
                                )}
                                onDragEnter={handleDragEnter}
                                onDragOver={handleDragOver}
                                onDragLeave={handleDragLeave}
                                onDrop={handleDrop}
                            >
                                {isDraggingFile && (
                                    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-primary/5 backdrop-blur-[1px] pointer-events-none">
                                        <span className="text-sm font-medium text-primary">Drop to attach</span>
                                    </div>
                                )}

                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".zip,application/zip"
                                    className="hidden"
                                    onChange={(e) => {
                                        const picked = e.target.files?.[0];
                                        if (picked) acceptFile(picked);
                                    }}
                                />

                                {file ? (
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium truncate">{file.name}</p>
                                                <p className="text-xs text-muted-foreground">{formatFileSize(file.size)} — ready to import</p>
                                            </div>
                                        </div>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                                            onClick={() => {
                                                setFile(null);
                                                if (fileInputRef.current) fileInputRef.current.value = "";
                                            }}
                                        >
                                            <X className="h-4 w-4" />
                                        </Button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className="flex w-full flex-col items-center gap-1 py-2 text-center"
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        <Upload className="h-5 w-5 text-muted-foreground" />
                                        <span className="text-sm font-medium">Click to upload a .zip file</span>
                                        <span className="text-xs text-muted-foreground">or drag and drop it here</span>
                                    </button>
                                )}
                            </div>
                        )}
                        {source === "github" && (
                            <div className="space-y-2">
                                <p className="text-xs text-muted-foreground">Public repositories only.</p>
                                <Input placeholder="Owner (e.g. anthropics)" value={owner} onChange={(e) => setOwner(e.target.value)} />
                                <Input placeholder="Repo (e.g. skills)" value={repo} onChange={(e) => setRepo(e.target.value)} />
                                <Input placeholder="Branch or tag (default: main)" value={ref} onChange={(e) => setRef(e.target.value)} />
                            </div>
                        )}
                        {source === "url" && (
                            <Input placeholder="https://example.com/my-skill.zip" value={url} onChange={(e) => setUrl(e.target.value)} />
                        )}
                    </div>

                    {error && <p className="text-xs text-destructive">{error}</p>}

                    <Button onClick={handleSubmit} disabled={submitting} className="w-full">
                        {submitting ? "Importing…" : "Import"}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
