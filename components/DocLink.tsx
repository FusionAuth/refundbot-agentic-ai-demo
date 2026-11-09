import type { ReactNode } from "react";
import { DOCS, type DocKey } from "@/lib/docs-links";

/** An outbound link to FusionAuth's docs: new tab, small "↗", consistent styling. */
export default function DocLink({
  to,
  children,
  className = "",
}: {
  to: DocKey;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={DOCS[to]}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-baseline gap-0.5 text-brand-ink underline decoration-brand/30 underline-offset-2 hover:decoration-brand ${className}`}
    >
      {children}
      <span aria-hidden className="text-[0.8em]">↗</span>
      <span className="sr-only"> (FusionAuth docs, opens in a new tab)</span>
    </a>
  );
}
