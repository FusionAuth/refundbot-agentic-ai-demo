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
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  if (!session) redirect(`/api/auth/login?redirect_uri=/refund/confirm/${encodeURIComponent(id)}`);

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
      <RefundConfirmPanel initial={view} initialReply={replyFor(view)} />
    </Shell>
  );
}
