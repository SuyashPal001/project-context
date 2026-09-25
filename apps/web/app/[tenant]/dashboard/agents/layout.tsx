import { redirect } from "next/navigation";
import { FEATURE_FLAGS } from "@/lib/feature-flags";

// The Employees section is switched off (FEATURE_FLAGS.employees): its catalog
// is still the old PM product's. Bookmarks and old links land on chat instead
// of a page the nav no longer offers.
export default async function AgentsLayout({ children, params }: {
    children: React.ReactNode;
    params: Promise<{ tenant: string }>;
}) {
    if (!FEATURE_FLAGS.employees) {
        const { tenant } = await params;
        redirect(`/${tenant}/dashboard/chat`);
    }
    return children;
}
