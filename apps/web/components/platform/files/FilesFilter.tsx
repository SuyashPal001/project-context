"use client";

import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface Props {
    officeCodes: string[];
    filterOffice: string;
    filterClassification: string;
    onOfficeChange: (v: string) => void;
    onClassificationChange: (v: string) => void;
    formatTypes: string[];
    filterFormat: string;
    onFormatChange: (v: string) => void;
}

export function FilesFilter({ officeCodes, filterOffice, filterClassification, onOfficeChange, onClassificationChange, formatTypes, filterFormat, onFormatChange }: Props) {
    return (
        <div className="flex gap-2">
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
            <Select value={filterFormat} onValueChange={onFormatChange}>
                <SelectTrigger className="w-36 h-8 text-xs bg-secondary border-border">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-secondary border-border">
                    <SelectItem value="all" className="text-xs">All Formats</SelectItem>
                    {formatTypes.map(f => (
                        <SelectItem key={f} value={f} className="text-xs">{f}</SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
