"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface RunsPaginationProps {
    page: number;
    totalPages: number;
    isLoading: boolean;
    onPrev: () => void;
    onNext: () => void;
}

export function RunsPagination({ page, totalPages, isLoading, onPrev, onNext }: RunsPaginationProps) {
    return (
        <div className="flex items-center justify-between px-1">
            <p className="text-xs text-muted-foreground">
                Page{" "}
                <span className="font-medium text-foreground">{page}</span>{" "}
                of{" "}
                <span className="font-medium text-foreground">{totalPages}</span>
            </p>
            <div className="flex items-center gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={onPrev}
                    disabled={page === 1 || isLoading}
                >
                    <ChevronLeft className="h-4 w-4" />
                    <span className="sr-only">Previous page</span>
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={onNext}
                    disabled={page >= totalPages || isLoading}
                >
                    <ChevronRight className="h-4 w-4" />
                    <span className="sr-only">Next page</span>
                </Button>
            </div>
        </div>
    );
}
