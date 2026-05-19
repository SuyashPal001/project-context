'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import * as mammoth from 'mammoth';
import { toast } from 'sonner';
import { FileText, Trash2, Plus, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type DocStatus = 'pending' | 'ready' | 'failed';

interface KBDocument {
  id: string;
  documentId?: string;
  name: string;
  type: string;
  status: DocStatus;
  chunks?: number;
  isPolling?: boolean;
  file?: File;
  previewUrl?: string;
  textContent?: string;
  htmlContent?: string;
  errorMessage?: string;
}

export function KnowledgeBaseSection() {
  const [documents, setDocuments] = useState<KBDocument[]>([]);
  const [previewDoc, setPreviewDoc] = useState<KBDocument | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KBDocument | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => { pollingRefs.current.forEach(id => clearTimeout(id)); };
  }, []);

  const pollDocumentStatus = useCallback((localId: string, documentId: string, attempt = 0) => {
    if (attempt >= 12) {
      setDocuments(prev => prev.map(d =>
        d.id === localId ? { ...d, status: 'failed' as const, isPolling: false } : d
      ));
      pollingRefs.current.delete(localId);
      return;
    }
    const timeoutId = setTimeout(async () => {
      try {
        const res = await fetch(`/api/proxy/api/v1/documents/${documentId}`);
        if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
        const data = await res.json();
        if (data.status === 'ready') {
          setDocuments(prev => prev.map(d =>
            d.id === localId ? { ...d, status: 'ready' as const, chunks: data.chunkCount, isPolling: false } : d
          ));
          pollingRefs.current.delete(localId);
        } else if (data.status === 'failed') {
          setDocuments(prev => prev.map(d =>
            d.id === localId ? { ...d, status: 'failed' as const, isPolling: false } : d
          ));
          pollingRefs.current.delete(localId);
        } else {
          pollDocumentStatus(localId, documentId, attempt + 1);
        }
      } catch {
        pollDocumentStatus(localId, documentId, attempt + 1);
      }
    }, 5000);
    pollingRefs.current.set(localId, timeoutId);
  }, []);

  const uploadSingleFile = async (file: File) => {
    const type = file.name.split('.').pop()?.toLowerCase() || 'unknown';
    const localId = crypto.randomUUID();
    const MAX_FILE_SIZE = 10 * 1024 * 1024;
    const newDoc: KBDocument = { id: localId, name: file.name, type, status: 'pending', isPolling: false, file };

    if (file.size > MAX_FILE_SIZE) {
      setDocuments(prev => [{ ...newDoc, status: 'failed', errorMessage: 'File exceeds 10MB limit' }, ...prev]);
      return;
    }
    if (type === 'pdf') newDoc.previewUrl = URL.createObjectURL(file);
    else if (type === 'txt') { try { newDoc.textContent = await file.text(); } catch { /* ignore */ } }
    else if (type === 'docx') {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer });
        newDoc.htmlContent = result.value;
      } catch { /* ignore */ }
    }
    setDocuments(prev => [newDoc, ...prev]);

    try {
      const buffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      const hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

      const urlRes = await fetch('/api/proxy/api/v1/documents/upload-url', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, mimeType: file.type }),
      });
      if (!urlRes.ok) throw new Error(`Failed to get upload URL: ${urlRes.status}`);
      const { uploadUrl, fileKey } = await urlRes.json();

      const s3Res = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      if (!s3Res.ok) throw new Error(`S3 upload failed: ${s3Res.status}`);

      const regRes = await fetch('/api/proxy/api/v1/documents', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, mimeType: file.type, fileKey, hash }),
      });
      if (!regRes.ok) {
        if (regRes.status === 409) {
          const errData = await regRes.json().catch(() => ({}));
          const dupDocumentId: string | undefined = errData.documentId;
          if (dupDocumentId) {
            setDocuments(prev => prev.map(d => d.id === localId ? { ...d, documentId: dupDocumentId, isPolling: true } : d));
            pollDocumentStatus(localId, dupDocumentId);
          } else {
            setDocuments(prev => prev.map(d => d.id === localId ? { ...d, status: 'ready' as const } : d));
          }
          return;
        }
        throw new Error(`Document registration failed: ${regRes.status}`);
      }
      const { documentId } = await regRes.json();
      setDocuments(prev => prev.map(d => d.id === localId ? { ...d, documentId, isPolling: true } : d));
      pollDocumentStatus(localId, documentId);
    } catch {
      setDocuments(prev => prev.map(d =>
        d.id === localId ? { ...d, status: 'failed' as const, isPolling: false } : d
      ));
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    files.forEach(file => { uploadSingleFile(file); });
  };

  const removeDocument = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const doc = documents.find(d => d.id === id);
    const pendingTimeout = pollingRefs.current.get(id);
    if (pendingTimeout !== undefined) { clearTimeout(pendingTimeout); pollingRefs.current.delete(id); }
    setDocuments(prev => {
      const d = prev.find(x => x.id === id);
      if (d?.previewUrl) URL.revokeObjectURL(d.previewUrl);
      return prev.filter(x => x.id !== id);
    });
    if (previewDoc?.id === id) setPreviewDoc(null);
    toast.success('Document deleted successfully');
    if (doc?.documentId) {
      try { await fetch(`/api/proxy/api/v1/documents/${doc.documentId}`, { method: 'DELETE' }); } catch { /* ignore */ }
    }
  };

  const downloadFile = (doc: KBDocument) => {
    if (!doc.file) return;
    const url = URL.createObjectURL(doc.file);
    const a = document.createElement('a');
    a.href = url; a.download = doc.name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="mx-4 mb-3 border-t border-border/60 pt-3 flex items-center justify-between">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">Knowledge Base</h4>
        <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full -mr-1" onClick={() => fileInputRef.current?.click()}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <input type="file" ref={fileInputRef} className="hidden" accept=".pdf,.docx,.txt" multiple onChange={handleFileUpload} />
      </div>

      <div className="px-4 pb-4 flex-1 flex flex-col">
        {documents.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border/60 bg-muted/10 min-h-[140px] cursor-pointer hover:bg-muted/20 transition-colors" onClick={() => fileInputRef.current?.click()}>
            <div className="h-10 w-10 rounded-full bg-muted/40 flex items-center justify-center">
              <Plus className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="text-center px-4">
              <p className="text-xs font-medium text-muted-foreground">Drop files here or click to upload</p>
              <p className="text-[10px] text-muted-foreground/60 mt-0.5">PDF, DOCX, or TXT · Max 10MB per file</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {documents.map((doc) => (
              <div key={doc.id} className="group relative flex flex-col p-3.5 rounded-xl border border-border/60 bg-card hover:bg-muted/40 transition-colors cursor-pointer text-sm shadow-sm min-h-[110px]" onClick={() => setPreviewDoc(doc)}>
                <div className="flex-1 mb-3 pr-4">
                  <h5 className="font-medium text-zinc-200 line-clamp-3 leading-snug break-words">{doc.name}</h5>
                  {doc.errorMessage && <p className="text-[10px] text-red-400 mt-1 leading-snug">{doc.errorMessage}</p>}
                  <p className="text-[11px] text-muted-foreground mt-1.5 font-medium flex items-center gap-1">
                    {doc.isPolling && <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0" />}
                    {doc.status === 'ready' ? `${doc.chunks} chunks` : doc.status === 'pending' ? 'Processing...' : 'Failed'}
                  </p>
                </div>
                <div className="flex items-center justify-between mt-auto">
                  <Badge variant="outline" className="text-[10px] font-semibold bg-transparent px-1.5 py-0 border-border/80 text-muted-foreground uppercase tracking-widest rounded-md">{doc.type}</Badge>
                </div>
                <div className="absolute top-2 right-2">
                  <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity bg-background/50 hover:bg-background/80" onClick={(e) => { e.stopPropagation(); setDeleteTarget(doc); }}>
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm bg-[#1C1C1C] border-[#2C2C2C] text-zinc-50">
          <DialogHeader>
            <DialogTitle>Delete Document</DialogTitle>
            <DialogDescription>Are you sure you want to delete &apos;{deleteTarget?.name}&apos;? This cannot be undone.</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { if (deleteTarget) { removeDocument(deleteTarget.id); setDeleteTarget(null); } }}>Delete</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!previewDoc} onOpenChange={(open) => !open && setPreviewDoc(null)}>
        <DialogContent className="max-w-4xl h-[85vh] flex flex-col p-0 gap-0 bg-[#1C1C1C] border-[#2C2C2C] text-zinc-50 overflow-hidden sm:rounded-xl">
          <DialogHeader className="flex-none p-4 border-b border-[#2C2C2C] bg-[#181818]">
            <DialogTitle className="text-xl font-medium truncate pr-6 text-zinc-100">{previewDoc?.name}</DialogTitle>
            <DialogDescription className="sr-only">Document preview</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto relative flex flex-col items-center justify-center p-4 bg-[#1C1C1C]">
            {previewDoc?.type === 'pdf' && previewDoc.previewUrl ? (
              <iframe src={`${previewDoc.previewUrl}#toolbar=0`} className="w-full h-full max-w-3xl border-0 rounded-md bg-white shadow-xl" title={previewDoc.name} />
            ) : previewDoc?.type === 'txt' ? (
              <div className="w-full h-full max-w-3xl bg-[#252525] p-6 rounded-md overflow-auto border border-[#333] shadow-xl">
                <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-300">{previewDoc.textContent}</pre>
              </div>
            ) : previewDoc?.type === 'docx' && previewDoc.htmlContent ? (
              <div className="w-full h-full max-w-3xl bg-white p-8 rounded-md overflow-auto shadow-xl text-black">
                <div className="prose prose-sm max-w-none prose-zinc" dangerouslySetInnerHTML={{ __html: previewDoc.htmlContent }} />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 text-zinc-500">
                <FileText className="h-16 w-16 opacity-50" />
                <p>Preview not available for .{previewDoc?.type} files</p>
              </div>
            )}
          </div>
          <div className="flex-none p-4 border-t border-[#2C2C2C] flex justify-center bg-[#181818]">
            <Button variant="ghost" className="text-zinc-300 hover:text-white hover:bg-zinc-800 gap-2 font-medium" onClick={() => previewDoc && downloadFile(previewDoc)}>
              <Download className="h-4 w-4" />Download
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
