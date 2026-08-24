import { useState } from "react";
import { getFileCategory, matchesTimeRange, TimeRange } from "../fileCategory";
import type { FileRecord } from "../types";

const PAGE_SIZE = 10;

export function useFileFilters(files: FileRecord[]) {
    const [filterOffice, setFilterOffice] = useState("all");
    const [filterClassification, setFilterClassification] = useState("all");
    const [filterCategory, setFilterCategory] = useState("all");
    const [filterTimeRange, setFilterTimeRange] = useState<TimeRange>("all");
    const [currentPage, setCurrentPage] = useState(1);

    // Resets to page 1 whenever a filter changes, since the previous page may
    // no longer exist under the new filtered set.
    const withPageReset = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setCurrentPage(1); };

    const filteredFiles = files.filter(f =>
        (filterOffice === "all" || f.officeCode === filterOffice) &&
        (filterClassification === "all" || f.classification === filterClassification) &&
        (filterCategory === "all" || getFileCategory(f.contentType, f.filename) === filterCategory) &&
        matchesTimeRange(f.createdAt, filterTimeRange));

    const totalPages = Math.max(1, Math.ceil(filteredFiles.length / PAGE_SIZE));
    const pagedFiles = filteredFiles.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

    return {
        filterOffice, onOfficeChange: withPageReset(setFilterOffice),
        filterClassification, onClassificationChange: withPageReset(setFilterClassification),
        filterCategory, onCategoryChange: withPageReset(setFilterCategory),
        filterTimeRange, onTimeRangeChange: withPageReset(setFilterTimeRange),
        currentPage, setCurrentPage,
        totalPages,
        filteredFiles,
        pagedFiles,
    };
}
