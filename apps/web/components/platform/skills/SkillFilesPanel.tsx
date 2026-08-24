"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy, Download, FileCode, FileImage, FileText, Grid2x2, List } from "lucide-react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { MarkdownViewer } from "@/components/platform/canvas/MarkdownViewer";
import { getSkillFileUrl } from "./actions";
import type { Skill, SkillFile } from "./types";

// Matches the server-side signed-URL TTL (skills.ts: expiresIn: 300) minus a
// safety margin, so a cached URL is never handed out already-expired.
const FILE_URL_STALE_MS = 4 * 60 * 1000;

const CODE_EXTENSIONS = new Set([
    "py", "js", "jsx", "ts", "tsx", "sh", "bash", "json", "yaml", "yml",
    "toml", "css", "html", "rb", "go", "java", "c", "cpp", "rs", "sql",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);

type FileKind = "image" | "pdf" | "docx" | "markdown" | "code" | "file";

function classifyFile(path: string): FileKind {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    if (ext === "pdf") return "pdf";
    if (ext === "docx" || ext === "doc") return "docx";
    if (ext === "md") return "markdown";
    if (CODE_EXTENSIONS.has(ext)) return "code";
    return "file";
}

// Same tinted-card language as AssetGallery.tsx (chat's asset grid) — a
// consistent color per format instead of a flat background for anything
// without a real per-file thumbnail.
const KIND_STYLES: Record<FileKind, { bg: string; icon: string; badge: string }> = {
    image: { bg: "bg-gradient-to-br from-emerald-500/20 via-teal-500/10 to-muted", icon: "text-emerald-400", badge: "IMG" },
    pdf: { bg: "bg-gradient-to-br from-red-500/20 via-orange-500/10 to-muted", icon: "text-red-400", badge: "PDF" },
    docx: { bg: "bg-gradient-to-br from-blue-500/20 via-sky-500/10 to-muted", icon: "text-blue-400", badge: "DOCX" },
    markdown: { bg: "bg-gradient-to-br from-slate-500/20 via-gray-500/10 to-muted", icon: "text-slate-400", badge: "MD" },
    code: { bg: "bg-gradient-to-br from-amber-500/20 via-yellow-500/10 to-muted", icon: "text-amber-400", badge: "CODE" },
    file: { bg: "bg-muted", icon: "text-muted-foreground/60", badge: "FILE" },
};

const KIND_ICONS: Record<FileKind, React.ElementType> = {
    image: FileImage,
    pdf: FileText,
    docx: FileText,
    markdown: FileText,
    code: FileCode,
    file: FileText,
};

interface TreeNode {
    name: string;
    path: string;
    type: "file" | "folder";
    size?: number;
    children: TreeNode[];
}

// Files come back as a flat list of full relative paths (e.g.
// "assets/templates/foo.md") from the S3 listing — group them into a tree
// client-side rather than changing what the API returns.
function buildFileTree(files: SkillFile[]): TreeNode[] {
    const root: TreeNode[] = [];
    const folders = new Map<string, TreeNode>();

    for (const file of files) {
        const parts = file.fileName.split("/").filter(Boolean);
        let path = "";
        let siblings = root;
        parts.forEach((part, i) => {
            path = path ? `${path}/${part}` : part;
            const isLeaf = i === parts.length - 1;
            if (isLeaf) {
                siblings.push({ name: part, path, type: "file", size: file.size, children: [] });
                return;
            }
            let folder = folders.get(path);
            if (!folder) {
                folder = { name: part, path, type: "folder", children: [] };
                folders.set(path, folder);
                siblings.push(folder);
            }
            siblings = folder.children;
        });
    }
    return root;
}

function isMarkdown(path: string): boolean {
    return path.toLowerCase().endsWith(".md");
}

function FileIcon({ path, className }: { path: string; className?: string }) {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return CODE_EXTENSIONS.has(ext) ? <FileCode className={className} /> : <FileText className={className} />;
}

function FileTreeRow({
    node, depth, selectedPath, onSelect, collapsed, onToggle,
}: {
    node: TreeNode;
    depth: number;
    selectedPath: string;
    onSelect: (path: string) => void;
    collapsed: Set<string>;
    onToggle: (path: string) => void;
}) {
    const indent = { paddingLeft: `${depth * 14 + 8}px` };

    if (node.type === "folder") {
        const isCollapsed = collapsed.has(node.path);
        return (
            <div>
                <button
                    type="button"
                    onClick={() => onToggle(node.path)}
                    style={indent}
                    className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm text-foreground hover:bg-accent"
                >
                    {isCollapsed
                        ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{node.name}</span>
                </button>
                {!isCollapsed && node.children.map((child) => (
                    <FileTreeRow
                        key={child.path}
                        node={child}
                        depth={depth + 1}
                        selectedPath={selectedPath}
                        onSelect={onSelect}
                        collapsed={collapsed}
                        onToggle={onToggle}
                    />
                ))}
            </div>
        );
    }

    const isSelected = node.path === selectedPath;
    return (
        <button
            type="button"
            onClick={() => onSelect(node.path)}
            style={indent}
            title={node.name}
            className={cn(
                "flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm hover:bg-accent",
                isSelected ? "bg-muted text-foreground" : "text-muted-foreground"
            )}
        >
            <FileIcon path={node.path} className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{node.name}</span>
        </button>
    );
}

function FileGridCard({ skillId, file, isSelected, onSelect }: { skillId: string; file: SkillFile; isSelected: boolean; onSelect: () => void }) {
    const kind = classifyFile(file.fileName);
    const style = KIND_STYLES[kind];
    const Icon = KIND_ICONS[kind];
    const name = file.fileName.split("/").pop() ?? file.fileName;

    // Only images get a real preview — everything else falls back to the
    // tinted icon card, same as AssetGallery.tsx for pdf/docx/audio.
    const { data: imageUrl } = useQuery({
        queryKey: ["skills", "file-url", skillId, file.fileName],
        queryFn: () => getSkillFileUrl(skillId, file.fileName),
        staleTime: FILE_URL_STALE_MS,
        enabled: kind === "image",
    });

    return (
        <button
            type="button"
            onClick={onSelect}
            title={file.fileName}
            className={cn(
                "group flex flex-col overflow-hidden rounded-xl border text-left transition-colors",
                isSelected ? "border-primary" : "border-border/60 hover:border-primary/40"
            )}
        >
            <div className={cn("relative aspect-video flex items-center justify-center", style.bg)}>
                {imageUrl ? (
                    <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
                ) : (
                    <Icon className={cn("h-7 w-7", style.icon)} />
                )}
                <span className="absolute bottom-1.5 right-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-black/60 text-white">
                    {style.badge}
                </span>
            </div>
            <div className="px-2 py-1.5">
                <p className="text-xs font-medium truncate text-foreground">{name}</p>
            </div>
        </button>
    );
}

function FileContentViewer({ skillId, path, skillBody }: { skillId: string; path: string; skillBody?: string | null }) {
    // SKILL.md's content is already in hand from the skill detail fetch — no
    // need for a second round trip to re-fetch what we already have.
    const isSkillMd = path === "SKILL.md" && !!skillBody;
    const queryClient = useQueryClient();

    // One cached signed URL per file, shared between viewing and downloading
    // — without this each click of Download re-signed a URL the content
    // fetch below had already resolved seconds earlier.
    const urlQueryKey = ["skills", "file-url", skillId, path] as const;
    const { data: url } = useQuery({
        queryKey: urlQueryKey,
        queryFn: () => getSkillFileUrl(skillId, path),
        staleTime: FILE_URL_STALE_MS,
        enabled: !isSkillMd,
    });

    // Package content at a pinned version is immutable, so once fetched it
    // never needs refetching — staleTime: Infinity means re-selecting a file
    // already viewed this session serves straight from cache.
    const { data: fetchedContent, isLoading } = useQuery({
        queryKey: ["skills", "file-content", skillId, path],
        queryFn: async () => {
            const res = await fetch(url!);
            if (!res.ok) throw new Error(`Failed to fetch file content: ${res.status}`);
            return res.text();
        },
        enabled: !isSkillMd && !!url,
        staleTime: Infinity,
    });

    const body = isSkillMd ? skillBody! : fetchedContent;

    const handleCopy = async () => {
        if (!body) return;
        await navigator.clipboard.writeText(body);
        toast.success("Copied to clipboard.");
    };

    const handleDownload = async () => {
        try {
            // Several browsers ignore <a download> / navigation on a
            // cross-origin S3 URL and render the file inline instead of
            // saving it — fetch as a blob and download that instead, same
            // pattern KnowledgeBaseSection.tsx uses for the same reason.
            let text = body;
            if (!text) {
                const downloadUrl = await queryClient.fetchQuery({
                    queryKey: urlQueryKey,
                    queryFn: () => getSkillFileUrl(skillId, path),
                    staleTime: FILE_URL_STALE_MS,
                });
                const res = await fetch(downloadUrl);
                if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
                text = await res.text();
            }
            const blob = new Blob([text], { type: "text/plain" });
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = objectUrl;
            a.download = path.split("/").pop() ?? path;
            a.click();
            URL.revokeObjectURL(objectUrl);
        } catch {
            toast.error("Failed to download file.");
        }
    };

    return (
        <div className="flex min-w-0 flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="truncate text-sm font-medium text-foreground" title={path}>{path}</span>
                <div className="flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        onClick={handleCopy}
                        title="Copy"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                        <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={handleDownload}
                        title="Download"
                        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                        <Download className="h-3.5 w-3.5" />
                    </button>
                </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto p-4">
                {!isSkillMd && isLoading ? (
                    <div className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-5/6" />
                        <Skeleton className="h-4 w-2/3" />
                    </div>
                ) : !body ? (
                    <p className="text-sm text-muted-foreground">Couldn&apos;t load this file.</p>
                ) : isMarkdown(path) ? (
                    <MarkdownViewer content={body} />
                ) : (
                    <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
                        {body}
                    </pre>
                )}
            </div>
        </div>
    );
}

export function SkillFilesPanel({ skill, files, filesLoading = false }: { skill: Skill; files: SkillFile[]; filesLoading?: boolean }) {
    const tree = useMemo(() => buildFileTree(files), [files]);
    const [viewMode, setViewMode] = useState<"tree" | "grid">("tree");
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    // Files can arrive after an import finishes polling, so the default is
    // derived on every render rather than committed to state — no effect
    // needed to "catch up" once they show up.
    const defaultPath = files.some((f) => f.fileName === "SKILL.md") ? "SKILL.md" : (files[0]?.fileName ?? "");
    const [explicitPath, setExplicitPath] = useState<string | null>(null);
    const selectedPath = explicitPath ?? defaultPath;

    const toggleFolder = (path: string) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path); else next.add(path);
            return next;
        });
    };

    if (files.length === 0) {
        // filesLoading only ever means "still loading" here — the query that
        // feeds it isn't even enabled until the skill's version is ready, so
        // an empty array during a real load reads as "no files" otherwise.
        if (filesLoading) {
            return (
                <div className="space-y-2">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-2/3" />
                </div>
            );
        }
        return <p className="text-sm text-muted-foreground">No files</p>;
    }

    return (
        <div className={cn(
            "grid overflow-hidden rounded-xl border border-border",
            viewMode === "grid" ? "md:grid-cols-[320px_1fr]" : "md:grid-cols-[220px_1fr]"
        )}>
            <div className="flex max-h-[480px] flex-col overflow-hidden border-b border-border md:border-b-0 md:border-r">
                <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border p-1.5">
                    <button
                        type="button"
                        onClick={() => setViewMode("tree")}
                        title="List view"
                        className={cn(
                            "flex h-6 w-6 items-center justify-center rounded-md",
                            viewMode === "tree" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        <List className="h-3.5 w-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={() => setViewMode("grid")}
                        title="Grid view"
                        className={cn(
                            "flex h-6 w-6 items-center justify-center rounded-md",
                            viewMode === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                        )}
                    >
                        <Grid2x2 className="h-3.5 w-3.5" />
                    </button>
                </div>
                <div className="overflow-y-auto p-2">
                    {viewMode === "tree" ? (
                        tree.map((node) => (
                            <FileTreeRow
                                key={node.path}
                                node={node}
                                depth={0}
                                selectedPath={selectedPath}
                                onSelect={setExplicitPath}
                                collapsed={collapsed}
                                onToggle={toggleFolder}
                            />
                        ))
                    ) : (
                        <div className="grid grid-cols-2 gap-2">
                            {files.map((file) => (
                                <FileGridCard
                                    key={file.fileName}
                                    skillId={skill.id}
                                    file={file}
                                    isSelected={file.fileName === selectedPath}
                                    onSelect={() => setExplicitPath(file.fileName)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
            {selectedPath && <FileContentViewer skillId={skill.id} path={selectedPath} skillBody={skill.body} />}
        </div>
    );
}
