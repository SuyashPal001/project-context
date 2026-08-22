import { redirect } from "next/navigation";

export default async function MarketplaceRedirectPage({
    params,
}: {
    params: Promise<{ tenant: string }>;
}) {
    const { tenant } = await params;
    redirect(`/${tenant}/dashboard/agents?tab=explore`);
}
