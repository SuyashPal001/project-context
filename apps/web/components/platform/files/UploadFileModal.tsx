"use client"

import { useState, useCallback, useRef, useMemo } from "react"
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { UploadCloud, File, X, CheckCircle2, Loader2, AlertCircle, FolderOpen, ChevronDown, Plus } from "lucide-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"

interface UploadFileModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentPrefix: string
  onSuccess: () => void
}

type FileStatus = {
  progress: number
  status: 'pending' | 'uploading' | 'confirming' | 'done' | 'error'
  error?: string
}

interface PersonFolder {
  id: string
  identifier: string
  displayName: string | null
  fileCount: number
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function uploadToS3(url: string, file: globalThis.File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`))
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.send(file)
  })
}

const NEW_FOLDER_VALUE = '__new__'

export function UploadFileModal({ open, onOpenChange, currentPrefix, onSuccess }: UploadFileModalProps) {
  const queryClient = useQueryClient()

  const { data: foldersData, isLoading: foldersLoading } = useQuery({
    queryKey: ['person-folders'],
    queryFn: () => api.get<{ data: PersonFolder[] }>('/api/v1/person-folders'),
    enabled: open,
  })

  const folders = foldersData?.data ?? []

  const [selectedFolderId, setSelectedFolderId] = useState<string>('')
  const [newIdentifier, setNewIdentifier] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<globalThis.File[]>([])
  const [isDragActive, setIsDragActive] = useState(false)
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileStatus>>({})
  const [isUploading, setIsUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isNewFolder = selectedFolderId === NEW_FOLDER_VALUE
  const selectedFolder = folders.find(f => f.id === selectedFolderId) ?? null
  const activeIdentifier = isNewFolder ? newIdentifier.trim() : (selectedFolder?.identifier ?? '')
  const folderReady = isNewFolder ? activeIdentifier.length > 0 : !!selectedFolder

  const prefixedName = (originalName: string) => `${activeIdentifier}-${originalName}`
  const objectKey = (originalName: string) => `${activeIdentifier}/${prefixedName(originalName)}`

  const { data: existingFilesData } = useQuery({
    queryKey: ['files', activeIdentifier ? `${activeIdentifier}/` : currentPrefix],
    queryFn: async () => {
      const prefix = activeIdentifier ? `${activeIdentifier}/` : currentPrefix
      const params = prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''
      return api.get<{ data: { key: string }[] }>(`/api/v1/files${params}`)
    },
    enabled: !!activeIdentifier,
  })

  const existingKeys = useMemo(
    () => new Set((existingFilesData?.data ?? []).map(f => f.key)),
    [existingFilesData]
  )
  const duplicateNames = useMemo(
    () => new Set(selectedFiles.filter(f => activeIdentifier && existingKeys.has(objectKey(f.name))).map(f => f.name)),
    [selectedFiles, existingKeys, activeIdentifier]
  )

  const updateStatus = (filename: string, update: Partial<FileStatus>) =>
    setFileStatuses(prev => ({ ...prev, [filename]: { ...prev[filename], ...update } }))

  const addFiles = (incoming: globalThis.File[]) => {
    setSelectedFiles(prev => {
      const existing = new Set(prev.map(f => f.name))
      return [...prev, ...incoming.filter(f => !existing.has(f.name))]
    })
    setFileStatuses(prev => ({
      ...prev,
      ...Object.fromEntries(incoming.map(f => [f.name, { progress: 0, status: 'pending' as const }])),
    }))
  }

  const removeFile = (name: string) => {
    setSelectedFiles(prev => prev.filter(f => f.name !== name))
    setFileStatuses(prev => { const n = { ...prev }; delete n[name]; return n })
  }

  const handleClose = () => {
    if (isUploading) return
    onOpenChange(false)
    setTimeout(() => {
      setSelectedFiles([])
      setFileStatuses({})
      setSelectedFolderId('')
      setNewIdentifier('')
    }, 300)
  }

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    setIsDragActive(e.type === 'dragenter' || e.type === 'dragover')
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation()
    setIsDragActive(false)
    addFiles(Array.from(e.dataTransfer.files))
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []))
    e.target.value = ''
  }

  async function uploadSingleFile(file: globalThis.File, personFolderId: string) {
    try {
      updateStatus(file.name, { status: 'uploading', progress: 0 })

      const res = await fetch('/api/proxy/api/v1/files/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: prefixedName(file.name),
          contentType: file.type || 'application/octet-stream',
          key: objectKey(file.name),
          personFolderId,
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to get upload URL')
      const { data } = await res.json()

      await uploadToS3(data.uploadUrl, file, pct => updateStatus(file.name, { progress: pct }))

      updateStatus(file.name, { status: 'confirming', progress: 100 })
      await fetch(`/api/proxy/api/v1/files/${data.fileId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: file.size }),
      })

      updateStatus(file.name, { status: 'done' })
    } catch (err: any) {
      updateStatus(file.name, { status: 'error', error: err.message })
    }
  }

  async function handleUpload() {
    if (!selectedFiles.length || !folderReady) return
    setIsUploading(true)

    let personFolderId = selectedFolder?.id ?? ''

    if (isNewFolder) {
      try {
        const res = await fetch('/api/proxy/api/v1/person-folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: activeIdentifier }),
        })
        if (!res.ok) throw new Error('Failed to create folder')
        const { data } = await res.json()
        personFolderId = data.id
        queryClient.invalidateQueries({ queryKey: ['person-folders'] })
      } catch (err: any) {
        setIsUploading(false)
        return
      }
    }

    await Promise.all(selectedFiles.map(f => uploadSingleFile(f, personFolderId)))
    setIsUploading(false)
    onSuccess()
  }

  const allSettled = selectedFiles.length > 0 &&
    selectedFiles.every(f => ['done', 'error'].includes(fileStatuses[f.name]?.status ?? ''))

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md bg-zinc-950 border-zinc-800">
        <DialogHeader>
          <DialogTitle>Upload Documents</DialogTitle>
          <DialogDescription>
            Select a person folder or create a new one, then upload files.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {/* Folder selector */}
          <div className="space-y-2">
            <label className="text-xs text-zinc-400 font-medium">Person Folder</label>
            {foldersLoading ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading folders…
              </div>
            ) : (
              <Select value={selectedFolderId} onValueChange={setSelectedFolderId} disabled={isUploading || allSettled}>
                <SelectTrigger className="bg-zinc-900 border-zinc-800 text-sm">
                  <SelectValue placeholder="Select or create a person folder…" />
                </SelectTrigger>
                <SelectContent className="bg-zinc-900 border-zinc-800">
                  {folders.map(f => (
                    <SelectItem key={f.id} value={f.id} className="text-sm">
                      <div className="flex items-center gap-2">
                        <FolderOpen className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                        <span className="font-mono">{f.identifier}</span>
                        {f.fileCount > 0 && (
                          <span className="text-zinc-500 text-xs">{f.fileCount} files</span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_FOLDER_VALUE} className="text-sm">
                    <div className="flex items-center gap-2 text-primary">
                      <Plus className="h-3.5 w-3.5 shrink-0" />
                      <span>New person folder…</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            )}

            {isNewFolder && (
              <Input
                placeholder="e.g. 3434-5766-8090"
                value={newIdentifier}
                onChange={e => setNewIdentifier(e.target.value)}
                disabled={isUploading || allSettled}
                className="bg-zinc-900 border-zinc-800 text-sm font-mono"
                autoFocus
              />
            )}

            {activeIdentifier && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-400">
                <FolderOpen className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                <span className="font-mono text-zinc-300">{activeIdentifier}/</span>
                <span className="text-zinc-600">·</span>
                <span>stored as <span className="font-mono">{activeIdentifier}-filename</span></span>
              </div>
            )}
          </div>


          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleChange} />

          {selectedFiles.length === 0 ? (
            <div
              className={`border-2 border-dashed rounded-lg p-10 flex flex-col items-center text-center transition-all duration-200 ${
                folderReady ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'
              } ${
                isDragActive
                  ? 'border-primary bg-primary/10'
                  : 'border-zinc-800 hover:border-zinc-600 hover:bg-zinc-900/50'
              }`}
              onDragEnter={folderReady ? handleDrag : undefined}
              onDragLeave={folderReady ? handleDrag : undefined}
              onDragOver={folderReady ? handleDrag : undefined}
              onDrop={folderReady ? handleDrop : undefined}
              onClick={() => folderReady && fileInputRef.current?.click()}
            >
              <UploadCloud className="h-8 w-8 text-zinc-500 mb-3" />
              <p className="text-sm font-medium text-zinc-200 mb-1">
                {folderReady ? 'Drop files here or click to browse' : 'Select a folder first'}
              </p>
              <p className="text-xs text-zinc-500">Multiple files · Scanned images, PDFs, DOCX</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                {selectedFiles.map(file => {
                  const s = fileStatuses[file.name]
                  return (
                    <div key={file.name} className="border rounded-lg p-3 border-zinc-800 bg-zinc-900/50">
                      <div className="flex items-center gap-3">
                        <File className="h-4 w-4 text-zinc-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-zinc-200 truncate">{file.name}</p>
                          <p className="text-xs text-zinc-500">{formatFileSize(file.size)}</p>
                        </div>
                        {s?.status === 'uploading' && (
                          <span className="text-xs text-primary font-mono shrink-0">{s.progress}%</span>
                        )}
                        {s?.status === 'confirming' && (
                          <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                        )}
                        {s?.status === 'done' && <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />}
                        {s?.status === 'error' && <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />}
                        {!isUploading && !allSettled && (
                          <button
                            onClick={() => removeFile(file.name)}
                            className="text-zinc-600 hover:text-red-400 transition-colors ml-1"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      {s?.status === 'uploading' && (
                        <div className="h-1 w-full bg-zinc-800 rounded-full mt-2">
                          <div
                            className="h-full bg-primary rounded-full transition-all duration-150"
                            style={{ width: `${s.progress}%` }}
                          />
                        </div>
                      )}
                      {s?.error && <p className="text-xs text-red-400 mt-1 truncate">{s.error}</p>}
                    </div>
                  )
                })}
              </div>
              {!isUploading && !allSettled && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  + Add more files
                </button>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="pt-4 border-t border-zinc-800/50">
          {allSettled ? (
            <Button onClick={handleClose} className="w-full">Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={handleClose} disabled={isUploading}>Cancel</Button>
              <Button onClick={handleUpload} disabled={!selectedFiles.length || isUploading || !folderReady}>
                {isUploading
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Uploading</>
                  : `Upload ${selectedFiles.length} file${selectedFiles.length !== 1 ? 's' : ''}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
