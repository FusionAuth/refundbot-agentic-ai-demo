import type { ReactNode } from "react";
import TopNav from "@/components/TopNav";
import { isAdmin, isSupportStaff } from "@/lib/roles";
import type { Session } from "@/lib/session";

/**
 * Shared chrome for every signed-in page: the session-aware TopNav plus a
 * centered content column. Kept a server component so pages can pass the
 * verified session straight through.
 */
export default function Shell({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}) {
  return (
    <>
      <TopNav
        name={session.name ?? session.email ?? "Signed in"}
        isAdmin={isAdmin(session.roles)}
        isStaff={isSupportStaff(session.roles)}
      />
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>
      <footer className="border-t border-line px-5 py-6 text-center text-xs text-ink-soft">
        RefundBot · built on InFusion Agent · a FusionAuth OAuth Token Exchange demo · no real money moves
      </footer>
    </>
  );
}
