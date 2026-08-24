"use client";

import { useState } from "react";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { FilesList } from "@/components/platform/files/FilesList";
import { UploadFileModal } from "@/components/platform/files/UploadFileModal";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/lib/hooks/usePermissions";
import { Upload } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

export default function FilesPage() {
    const { can } = usePermissions();
    const queryClient = useQueryClient();
    const [isUploadOpen, setIsUploadOpen] = useState(false);
    const [currentPrefix, setCurrentPrefix] = useState("");

    const canUpload = can('files', 'create');

    return (
        <PermissionGate resource="files" action="read">
            <div className="space-y-6">
                <div className="flex justify-between items-center">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-foreground">
                            Drive
                        </h1>
                        <p className="text-muted-foreground mt-2">
                            Upload documents for your AI team. Multi-format detection · OCR extraction · RAG indexed.
                        </p>
                    </div>
                    {canUpload && (
                        <Button onClick={() => setIsUploadOpen(true)}>
                            <Upload className="w-4 h-4 mr-2" />
                            {currentPrefix ? 'Add Files' : 'Upload Document'}
                        </Button>
                    )}
                </div>
                
                <FilesList 
                    prefix={currentPrefix} 
                    onPrefixChange={setCurrentPrefix} 
                    onUploadClick={() => setIsUploadOpen(true)}
                    canUpload={canUpload}
                    canDelete={can('files', 'delete')}
                />
                
                <UploadFileModal
                    open={isUploadOpen}
                    onOpenChange={setIsUploadOpen}
                    currentPrefix={currentPrefix}
                    onSuccess={(folderName) => {
                        queryClient.invalidateQueries({ queryKey: ['files'] });
                        if (!currentPrefix) setCurrentPrefix(`${folderName}/`);
                    }}
                />
            </div>
        </PermissionGate>
    );
}
