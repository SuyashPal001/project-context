import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

export function useFileSelection() {
    const queryClient = useQueryClient();
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [bulkDeleting, setBulkDeleting] = useState(false);

    const toggleSelect = (id: string) => {
        setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    };

    const toggleSelectAll = (pageIds: string[]) => {
        setSelectedIds(prev => {
            const allSelected = pageIds.length > 0 && pageIds.every(id => prev.has(id));
            const next = new Set(prev);
            if (allSelected) pageIds.forEach(id => next.delete(id));
            else pageIds.forEach(id => next.add(id));
            return next;
        });
    };

    const bulkDelete = async () => {
        const total = selectedIds.size;
        setBulkDeleting(true);
        let failCount = 0;
        for (const id of selectedIds) {
            try { await api.del(`/api/v1/files/${id}`); } catch { failCount++; }
        }
        setBulkDeleting(false);
        setSelectedIds(new Set());
        queryClient.invalidateQueries({ queryKey: ['files'] });
        if (failCount > 0) {
            toast.error(`Deleted ${total - failCount} of ${total} file${total !== 1 ? 's' : ''} — ${failCount} failed`);
        } else {
            toast.success(`Deleted ${total} file${total !== 1 ? 's' : ''}`);
        }
    };

    return { selectedIds, toggleSelect, toggleSelectAll, bulkDeleting, bulkDelete };
}
