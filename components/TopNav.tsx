"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface TopNavProps {
  name: string;
  isAdmin: boolean;
  /** Holds an employee role — sees the approval console and the original employee demo. */
  isStaff?: boolean;
}

const BASE_LINKS = [{ href: "/refund", label: "RefundBot" }];
const STAFF_LINKS = [
  { href: "/support/approvals", label: "Approvals" },
  { href: "/chat", label: "Ask Fusion" },
];

/**
 * The signed-in chrome: InFusion Agent lockup, section links (Admin only shows
 * for the admin role), and a sign-out that hits the /api/auth/logout SSO round
 * trip.
 */
export default function TopNav({ name, isAdmin, isStaff }: TopNavProps) {
  const pathname = usePathname();
  const links = [
    ...BASE_LINKS,
    ...(isStaff || isAdmin ? STAFF_LINKS : []),
    ...(isAdmin ? [{ href: "/admin", label: "Admin" }] : []),
  ];

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-card/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-md bg-ink text-sm font-bold text-white font-display"
            aria-hidden="true"
          >
            RB
          </span>
          <span className="text-base font-bold tracking-tight text-ink font-display">
            RefundBot
          </span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {links.map((link) => {
            const active =
              pathname === link.href || pathname.startsWith(`${link.href}/`);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-brand-soft text-brand-ink"
                    : "text-ink-soft hover:text-ink"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-ink-soft md:inline">{name}</span>
          <a
            href="/api/auth/logout"
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface"
          >
            Sign out
          </a>
        </div>
      </div>
    </header>
  );
}
