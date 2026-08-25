"use client";

import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { FileCategory, FILE_CATEGORY_LABELS, TimeRange, TIME_RANGE_LABELS } from "./fileCategory";

const CATEGORIES: FileCategory[] = ['document', 'image', 'audio-video', 'archive', 'other'];
const TIME_RANGES: TimeRange[] = ['all', 'today', '7d', '30d', 'older'];

interface Props {
    workspaceNames: string[];
    filterWorkspace: string;
    filterClassification: string;
    onWorkspaceChange: (v: string) => void;
    onClassificationChange: (v: string) => void;
    filterCategory: string;
    onCategoryChange: (v: string) => void;
    filterTimeRange: TimeRange;
    onTimeRangeChange: (v: TimeRange) => void;
    showPipelineDetails?: boolean;
}

export function FilesFilter({ workspaceNames, filterWorkspace, filterClassification, onWorkspaceChange, onClassificationChange, filterCategory, onCategoryChange, filterTimeRange, onTimeRangeChange, showPipelineDetails = false }: Props) {
    return (
        <div className="flex gap-2">
            <Select value={filterCategory} onValueChange={onCategoryChange}>
                <SelectTrigger className="w-36 h-8 text-xs bg-secondary border-border">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-secondary border-border">
                    <SelectItem value="all" className="text-xs">All Types</SelectItem>
                    {CATEGORIES.map(c => (
                        <SelectItem key={c} value={c} className="text-xs">{FILE_CATEGORY_LABELS[c]}</SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <Select value={filterTimeRange} onValueChange={(v) => onTimeRangeChange(v as TimeRange)}>
                <SelectTrigger className="w-40 h-8 text-xs bg-secondary border-border">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-secondary border-border">
                    {TIME_RANGES.map(r => (
                        <SelectItem key={r} value={r} className="text-xs">{TIME_RANGE_LABELS[r]}</SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {showPipelineDetails && (
                <Select value={filterWorkspace} onValueChange={onWorkspaceChange}>
                    <SelectTrigger className="w-36 h-8 text-xs bg-secondary border-border">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-secondary border-border">
                        <SelectItem value="all" className="text-xs">All Workspaces</SelectItem>
                        {workspaceNames.map(c => (
                            <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
            {showPipelineDetails && (
                <Select value={filterClassification} onValueChange={onClassificationChange}>
                    <SelectTrigger className="w-44 h-8 text-xs bg-secondary border-border">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-secondary border-border">
                        {(["all", "Confidential", "Internal"] as const).map(v => (
                            <SelectItem key={v} value={v} className="text-xs">
                                {v === "all" ? "All Classifications" : v}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
        </div>
    );
}
