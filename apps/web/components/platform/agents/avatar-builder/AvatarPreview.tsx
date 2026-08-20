// apps/web/components/platform/agents/avatar-builder/AvatarPreview.tsx
"use client";

import * as React from "react";
import type { AvatarParams } from "./avatarParams";
import { buildAvatarSvg } from "./buildAvatarSvg";

interface AvatarPreviewProps {
    params: AvatarParams;
}

export function AvatarPreview({ params }: AvatarPreviewProps) {
    const svgMarkup = React.useMemo(() => buildAvatarSvg(params), [params]);

    return (
        <div
            className="h-64 w-64 rounded-2xl border-2 border-border bg-muted/40 flex items-center justify-center overflow-hidden"
            // buildAvatarSvg only ever interpolates AvatarParams' closed enum
            // values and hex color strings — never free text — so this is not
            // an injection surface. See the design spec's security section.
            dangerouslySetInnerHTML={{ __html: svgMarkup }}
        />
    );
}
