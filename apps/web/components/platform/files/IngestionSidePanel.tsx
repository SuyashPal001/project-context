"use client";

import { X, Database } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ExtractedField {
    key: string;
    label: string;
    value: string;
    confidence: number;
}

export interface IngestionFileRecord {
    id: string;
    filename: string;
    formatDetected: string | null;
    officeCode: string;
    classification: string;
    chunkCount: number;
    ingestionStatus: string;
    extractedFields: ExtractedField[] | null;
    createdAt: string;
}

interface Props {
    file: IngestionFileRecord;
    onClose: () => void;
}

const PIPELINE_STEPS = [
    { id: 'detectFormat', label: 'detectFormat' },
    { id: 'classify',     label: 'classify' },
    { id: 'extract',      label: 'extract' },
    { id: 'validate',     label: 'validate' },
    { id: 'commit',       label: 'commit' },
    { id: 'embed',        label: 'embed' },
];

function getStepState(idx: number, status: string): 'done' | 'active' | 'idle' {
    if (status === 'done') return 'done';
    if (status === 'failed') return idx < 4 ? 'done' : 'idle';
    if (status === 'processing') {
        if (idx < 2) return 'done';
        if (idx === 2) return 'active';
    }
    return 'idle';
}

function ConfidenceBar({ value }: { value: number }) {
    const pct = Math.round(value * 100);
    const color = pct >= 90 ? 'bg-green-500' : pct >= 75 ? 'bg-amber-500' : 'bg-red-500';
    return (
        <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-zinc-400 font-mono w-9 text-right">{pct}%</span>
        </div>
    );
}

export function IngestionSidePanel({ file, onClose }: Props) {
    return (
        <div className="w-72 shrink-0 border border-zinc-800 rounded-lg bg-zinc-950 overflow-y-auto max-h-[70vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-zinc-800">
                <div className="flex items-center gap-2">
                    <Database className="w-3.5 h-3.5 text-blue-400" />
                    <h3 className="text-sm font-semibold text-zinc-200">Document Details</h3>
                </div>
                <Button variant="ghost" size="icon" className="h-6 w-6 text-zinc-500 hover:text-zinc-300" onClick={onClose}>
                    <X className="w-3 h-3" />
                </Button>
            </div>

            <div className="p-4 space-y-4 flex-1 overflow-y-auto">
                {/* Metadata */}
                <div className="space-y-2.5">
                    {[
                        { label: 'File', value: file.filename, className: 'text-zinc-300 truncate max-w-[160px]' },
                        { label: 'Format', value: file.formatDetected ?? '—', className: 'text-zinc-300 font-mono' },
                        { label: 'Office', value: file.officeCode, className: 'text-blue-400 font-mono' },
                        { label: 'Classification', value: file.classification, className: file.classification === 'Confidential' ? 'text-red-400' : 'text-amber-400' },
                        { label: 'Chunks', value: String(file.chunkCount || '—'), className: 'text-zinc-300' },
                        { label: 'Embeddings', value: file.chunkCount > 0 ? `✅ ${file.chunkCount} vectors` : '—', className: 'text-green-400' },
                        { label: 'Lakehouse', value: file.ingestionStatus === 'done' ? '✅ Written' : '⏳ Pending', className: file.ingestionStatus === 'done' ? 'text-green-400' : 'text-amber-400' },
                    ].map(({ label, value, className }) => (
                        <div key={label} className="flex justify-between items-baseline gap-2">
                            <span className="text-xs text-zinc-500 shrink-0">{label}</span>
                            <span className={`text-xs ${className} text-right`} title={value}>{value}</span>
                        </div>
                    ))}
                </div>

                {/* Extracted Fields */}
                {file.extractedFields && file.extractedFields.length > 0 && (
                    <div className="border-t border-zinc-800 pt-4">
                        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                            Extracted Fields
                        </p>
                        <div className="space-y-3.5">
                            {file.extractedFields.map((field) => (
                                <div key={field.key}>
                                    <div className="flex justify-between items-baseline gap-2">
                                        <span className="text-xs text-zinc-500 shrink-0">{field.label}</span>
                                        <span className="text-xs font-medium text-zinc-200 text-right">{field.value}</span>
                                    </div>
                                    <ConfidenceBar value={field.confidence} />
                                </div>
                            ))}
                        </div>
                        <p className="text-xs text-zinc-600 mt-4 border-t border-zinc-800/50 pt-3">
                            Extracted via Vision LLM · Self-hosted for Confidential data
                        </p>
                    </div>
                )}

                {!file.extractedFields && file.ingestionStatus === 'done' && (
                    <div className="border-t border-zinc-800 pt-4">
                        <p className="text-xs text-zinc-500">
                            Text extracted directly — {file.chunkCount} chunks indexed to vector store.
                        </p>
                    </div>
                )}

                {file.ingestionStatus === 'processing' && (
                    <div className="border-t border-zinc-800 pt-4 flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                        <p className="text-xs text-amber-400">Vision LLM processing document…</p>
                    </div>
                )}

                {/* Pipeline Lineage */}
                <div className="border-t border-zinc-800 pt-4">
                    <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Pipeline Steps</p>
                    <div className="space-y-1.5">
                        {PIPELINE_STEPS.map((step, idx) => {
                            const state = getStepState(idx, file.ingestionStatus);
                            return (
                                <div key={step.id} className="flex items-center gap-2">
                                    <span className="text-sm leading-none">
                                        {state === 'done' ? '✅' : state === 'active' ? '⏳' : '⬜'}
                                    </span>
                                    <span className={`text-xs font-mono ${
                                        state === 'done' ? 'text-zinc-300' :
                                        state === 'active' ? 'text-amber-400 animate-pulse' :
                                        'text-zinc-600'}`}>
                                        {step.label}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}
