"use client";

import { useRef, useState } from "react";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { FilesList, type FilesListHandle } from "@/components/platform/files/FilesList";
import { NewAvatarButton } from "@/components/platform/files/NewAvatarButton";
import { UploadFileModal } from "@/components/platform/files/UploadFileModal";
import { Button } from "@/components/ui/button";
import { usePermissions } from "@/lib/hooks/usePermissions";
import { Plus, Upload } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { uploadLabelForPrefix } from "@/components/platform/files/systemFolders";

export default function FilesPage() {
    const { can } = usePermissions();
    const queryClient = useQueryClient();
    const [isUploadOpen, setIsUploadOpen] = useState(false);
    const [currentPrefix, setCurrentPrefix] = useState("");
    const filesListRef = useRef<FilesListHandle>(null);

    const canUpload = can('files', 'create');
    const onProductsTab = currentPrefix.startsWith('creative-products/');

    return (
        <PermissionGate resource="files" action="read">
            <div className="space-y-6">
                <div className="flex justify-between items-center">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-foreground">
                            Drive
                        </h1>
                        <p className="text-muted-foreground mt-2">
                            Upload once — then put any file to work in a chat.
                        </p>
                    </div>
                    {canUpload && (
                        onProductsTab
                            ? <Button onClick={() => filesListRef.current?.openNewProduct()}>
                                <Plus className="w-4 h-4 mr-2" />
                                New product
                            </Button>
                            : currentPrefix.startsWith('creative-avatars/')
                                ? <NewAvatarButton onUpload={() => setIsUploadOpen(true)} />
                                : <Button onClick={() => setIsUploadOpen(true)}>
                                    <Upload className="w-4 h-4 mr-2" />
                                    {uploadLabelForPrefix(currentPrefix)}
                                </Button>
                    )}
                </div>

                <FilesList
                    ref={filesListRef}
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
