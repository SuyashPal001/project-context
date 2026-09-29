"use client";

import { useParams, useRouter } from "next/navigation";
import { ChevronDown, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useOfficialSkill } from "@/components/platform/skills/useOfficialSkill";
import { startOfficialSkill } from "@/components/platform/skills/startOfficialSkill";

export const CREATE_AVATAR_PROMPT = 'Create a new avatar for my ads';
export const AVATAR_CREATOR_SKILL_SLUG = 'avatar-creator';

/** Bring your own photo, or let the agent create one in chat — both land in Drive › Avatars. */
export function NewAvatarButton({ onUpload }: { onUpload: () => void }) {
    const router = useRouter();
    const { tenant } = useParams<{ tenant: string }>();
    const avatarCreatorSkill = useOfficialSkill(AVATAR_CREATOR_SKILL_SLUG);

    const handleCreateWithAI = () => {
        if (avatarCreatorSkill) {
            void startOfficialSkill(avatarCreatorSkill, tenant, router);
            return;
        }
        // Official skill not seeded yet — fall back to today's behaviour.
        router.push(`/${tenant}/dashboard/chat?prompt=${encodeURIComponent(CREATE_AVATAR_PROMPT)}`);
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button>
                    New avatar
                    <ChevronDown className="w-4 h-4 ml-2" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onUpload}>
                    <Upload className="w-4 h-4 mr-2" /> Upload photo
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleCreateWithAI}>
                    <Sparkles className="w-4 h-4 mr-2" /> Create with AI
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
