import { notFound, redirect } from "next/navigation";
import Shell from "@/components/Shell";
import RefundConfirmPanel from "@/components/RefundConfirmPanel";
import { getSession } from "@/lib/session";
import { findRefund, toView } from "@/lib/approvals";
import { replyFor } from "@/lib/refund-replies";

export const dynamic = "force-dynamic";

/**
 * /refund/confirm/<id> — where a refund requested from ChatGPT / claude.ai (the /mcp
 * connector) gets the customer's mandatory out-of-band confirmation. The chat app only
 * gets this link; confirming takes the customer's own browser session plus FusionAuth's
 * step-up check. Only the request's own customer can see it.
 */
export default async function RefundConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  // Only two known values; anything else (or nothing) keeps the web app's own return link.
  const returnTo = from === "agentcore" ? "agentcore" : "refund";
  const session = await getSession();
  if (!session) {
    const path = `/refund/confirm/${encodeURIComponent(id)}`;
    redirect(
      returnTo === "agentcore"
        ? `/api/auth/login?redirect_uri=${encodeURIComponent(`${path}?from=agentcore`)}`
        : `/api/auth/login?redirect_uri=${path}`
    );
  }

  const record = findRefund(id);
  if (!record || record.customerId !== session.userId) notFound();
  const view = toView(record);

  return (
    <Shell session={session}>
      <div className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-ink font-display">
          Confirm your refund
        </h1>
        <p className="text-sm text-ink-soft">
          Requested from your AI assistant. Only you can confirm it, here.
        </p>
      </div>
      <RefundConfirmPanel initial={view} initialReply={replyFor(view)} returnTo={returnTo} />
    </Shell>
  );
}
