"use client";

import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { FileCategory, FILE_CATEGORY_LABELS } from "./fileCategory";

const CATEGORIES: FileCategory[] = ['document', 'image', 'audio-video', 'archive', 'other'];

interface Props {
    officeCodes: string[];
    filterOffice: string;
    filterClassification: string;
    onOfficeChange: (v: string) => void;
    onClassificationChange: (v: string) => void;
    filterCategory: string;
    onCategoryChange: (v: string) => void;
}

export function FilesFilter({ officeCodes, filterOffice, filterClassification, onOfficeChange, onClassificationChange, filterCategory, onCategoryChange }: Props) {
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
            <Select value={filterOffice} onValueChange={onOfficeChange}>
                <SelectTrigger className="w-36 h-8 text-xs bg-secondary border-border">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-secondary border-border">
                    <SelectItem value="all" className="text-xs">All Offices</SelectItem>
                    {officeCodes.map(c => (
                        <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
                    ))}
                </SelectContent>
            </Select>
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
        </div>
    );
}
