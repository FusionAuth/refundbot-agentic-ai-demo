import { formatUsd, type RefundRequestView } from "@/lib/refund-types";

/**
 * What RefundBot tells the customer about a request, by state. Shared by the web chat
 * (app/api/refund) and the customer-facing MCP connector (app/mcp), so both surfaces
 * say the same thing.
 */
export function replyFor(view: RefundRequestView): string {
  const amount = view.amountCents !== undefined ? formatUsd(view.amountCents) : "";
  const item = view.orderSummary ?? view.orderId;
  const said = (label: string) =>
    view.trace.some((e) => e.type === "note" && e.label.includes(label));
  switch (view.decision) {
    case "stopped":
      if (view.fga.ownership && !view.fga.ownership.allowed) {
        return `I can't refund ${view.orderId} — it isn't on an account you own or share. If it's from a family or shared account, ask the account owner to add you as a delegate.`;
      }
      if (view.amountCents === undefined) {
        return `I couldn't find an order ${view.orderId} on your account, so there's nothing I can refund. If you think that's wrong, double-check the order number in your confirmation email.`;
      }
      if (said("already refunded")) return `${item} has already been refunded — you should see it on your statement within 3–5 business days.`;
      if (said("budget")) return `I can't process ${item} automatically right now. Please try again tomorrow or contact us by email.`;
      return `I'm not able to refund ${item}.`;
    case "failed":
      return "Something went wrong while processing that, and nothing was charged back. Please try again in a moment.";
    case "awaiting_approvals":
      if (view.customer.state === "pending") {
        if (view.needsEmployee) {
          return `I found ${item} for ${amount}. Refunds over ${formatUsd(view.floorCents ?? 0)} also get a quick review by one of our specialists. First, please confirm you want this refund:`;
        }
        return view.fga.tier?.autoApprove
          ? `I found ${item} for ${amount}. Your ${view.fga.tier.accountLabel.toLowerCase()} is trusted for refunds up to ${formatUsd(view.fga.tier.capCents)}, so no review is needed — just confirm it's really you:`
          : `I found ${item} for ${amount}, and it's eligible for an instant refund. Please confirm you want to go ahead:`;
      }
      return `Thanks for confirming! A specialist is reviewing your ${amount} refund now — usually within a few minutes. I'll update you right here.`;
    case "executing":
      return "Everything's approved — processing your refund now.";
    case "refunded":
      return `Done! ${amount} is on its way back to your original payment method (3–5 business days). Your confirmation number is ${view.confirmationId}.`;
    case "denied":
      return `I'm sorry — our specialist reviewed the ${amount} refund for ${item} and wasn't able to approve it. Nothing was charged back. Reply here if you'd like to talk it through.`;
    case "declined":
      return "No problem — I've cancelled that refund request. Nothing was processed.";
  }
}
