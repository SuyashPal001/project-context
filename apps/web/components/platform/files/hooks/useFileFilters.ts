import { useState } from "react";
import { getFileCategory, matchesTimeRange, TimeRange } from "../fileCategory";
import type { FileRecord } from "../types";

const PAGE_SIZE = 10;

export function useFileFilters(files: FileRecord[], folderCount = 0) {
    const [filterWorkspace, setFilterWorkspace] = useState("all");
    const [filterClassification, setFilterClassification] = useState("all");
    const [filterCategory, setFilterCategory] = useState("all");
    const [filterTimeRange, setFilterTimeRange] = useState<TimeRange>("all");
    const [currentPage, setCurrentPage] = useState(1);

    // Resets to page 1 whenever a filter changes, since the previous page may
    // no longer exist under the new filtered set.
    const withPageReset = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setCurrentPage(1); };

    const filteredFiles = files.filter(f =>
        (filterWorkspace === "all" || f.workspaceName === filterWorkspace) &&
        (filterClassification === "all" || f.classification === filterClassification) &&
        (filterCategory === "all" || getFileCategory(f.contentType, f.filename) === filterCategory) &&
        matchesTimeRange(f.createdAt, filterTimeRange));

    // Folders are rows too, so they draw from the same page budget instead of
    // riding above it. Left outside, a prefix with exactly PAGE_SIZE files showed
    // no pager at all while still rendering folders on top of a full page.
    // The combined list is folders first, then files: folders take the leading
    // `folderCount` slots and the files pick up where those run out.
    const totalItems = folderCount + filteredFiles.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    // Deleting a selection — or the 5s poll dropping rows — can shrink the list
    // below the page you are standing on. Clamping here rather than writing the
    // state back keeps it a render-time derivation: the stale page number costs
    // nothing, and the next click sets a valid one.
    const page = Math.min(currentPage, totalPages);
    const pageStart = (page - 1) * PAGE_SIZE;
    const pageEnd = pageStart + PAGE_SIZE;

    const folderRange = {
        start: Math.min(pageStart, folderCount),
        end: Math.min(pageEnd, folderCount),
    };
    const pagedFiles = filteredFiles.slice(
        Math.max(0, pageStart - folderCount),
        Math.max(0, pageEnd - folderCount),
    );

    return {
        filterWorkspace, onWorkspaceChange: withPageReset(setFilterWorkspace),
        filterClassification, onClassificationChange: withPageReset(setFilterClassification),
        filterCategory, onCategoryChange: withPageReset(setFilterCategory),
        filterTimeRange, onTimeRangeChange: withPageReset(setFilterTimeRange),
        currentPage: page, setCurrentPage,
        totalPages,
        filteredFiles,
        pagedFiles,
        folderRange,
    };
}
