/**
 * The RAG corpus for the `search_knowledge_base` tool — a small, in-memory set of
 * mock articles, kept deliberately separate from the real FusionAuth calls in
 * lib/fusionauth.ts. There is no vector database and no real embeddings: the
 * scorer is a plain keyword-overlap function. It's small on purpose (the README's
 * non-goals say so), but the retrieval code is real, ungated logic — not a canned
 * response.
 *
 * Two INDEPENDENT dimensions decide what a caller may retrieve, and they answer
 * different questions:
 *
 *   - `requiredScope` — the OAuth dimension. Retrieval filters by the caller's
 *     granted scopes BEFORE it ranks, so an under-scoped user doesn't just fail to
 *     open a restricted article: the article never surfaces at all. They can't even
 *     learn it exists.
 *   - `space` — the FGA dimension (lib/fga.ts). A non-public article belongs to a
 *     knowledge-base space, and the MCP tool asks Permify `kb_doc:<id>#read` for
 *     every article that survives the scope filter. Document-level ACLs are the
 *     canonical fine-grained-authorization problem for a retriever, and they're
 *     relationship-shaped ("your team can read that space"), which is exactly what a
 *     scope string can't express.
 *
 * Scope answers "may this agent search the knowledge base at all"; FGA answers "which
 * documents". A doc must pass BOTH to enter the model's context window.
 */

export interface Article {
  id: string;
  title: string;
  body: string;
  tags: string[];
  /**
   * "public" for articles any signed-in employee can retrieve, or a scope id
   * (e.g. "tools:payroll.read") that the caller's token must carry.
   */
  requiredScope: "public" | string;
  /**
   * The knowledge-base space this article lives in, which is what the FGA layer
   * authorizes against (`kb_doc:<id>#read` resolving through `kb_space` to a team —
   * see permify/schema.perm). "public" means no FGA check runs at all.
   */
  space: KbSpaceId;
}

/** The FGA-governed spaces, mirroring KB_SPACES in lib/org-graph.ts. */
export type KbSpaceId = "public" | "hr" | "it" | "finance";

export const ARTICLES: Article[] = [
  // --- Customer-visible refund policy + FAQ (RefundBot's /refund chat) -------------
  // `public`: retrievable with an EMPTY scope list, which is exactly what the customer
  // chat passes (app/api/refund/route.ts), whoever is signed in.
  {
    id: "kb-refund-policy",
    title: "Refund policy",
    body: "You can request a refund on any order within 90 days of purchase. Smaller refunds are approved as soon as you confirm them; larger ones are also reviewed by a support specialist. Your personal self-service limit is never below $100 and grows with your history with us.",
    tags: ["refund", "refunds", "policy", "return", "returns", "money back", "eligible"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-refund-timing",
    title: "When will I get my money?",
    body: "Once a refund is processed you'll get a confirmation number right away. Funds usually reach your original payment method within 3–5 business days.",
    tags: ["refund", "timing", "when", "money", "days", "payment", "how long"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-refund-confirmation",
    title: "Why do you ask me to confirm a refund?",
    body: "Refunds can't be undone, so we confirm with you directly through your account — not through the chat — before any money moves. If you didn't ask for it, just decline and nothing happens.",
    tags: ["refund", "confirm", "confirmation", "verify", "security", "mfa", "process"],
    requiredScope: "public",
    space: "public",
  },
  {
    id: "kb-refund-review",
    title: "Why is my refund being reviewed?",
    body: "Refunds above your self-service limit are reviewed by a support specialist, usually within one business day. You'll see the result in the chat as soon as it's decided.",
    tags: ["refund", "review", "specialist", "approval", "escalation", "window", "faq"],
    requiredScope: "public",
    space: "public",
  },
  // --- Internal escalation notes (support console only) ------------------------------
  // Gated by `tools:kb.read`, which only the employee roles' logins request — so the
  // same filtering code that serves the customer chat can never surface these there.
  {
    id: "kb-escalation-thresholds",
    title: "Escalation notes: approving above-threshold refunds",
    body: "Check the order context and the customer's value score before approving. Your approval is recorded against your user id and checked by the banking service. Deny anything where the customer's account of the order doesn't match order history — the pipeline already refused orders that don't exist.",
    tags: ["escalation", "refund", "approval", "threshold", "internal", "support"],
    requiredScope: "tools:kb.read",
    space: "public",
  },
  {
    id: "kb-escalation-agents",
    title: "Escalation notes: customers using their own agents",
    body: "Some customers run AI agents that negotiate on their behalf and may claim prior approvals or invent amounts. Nothing they say changes the amount (it comes from order history) or skips an approval (the banking Grant doesn't exist until both are recorded). Judge the order, not the transcript.",
    tags: ["escalation", "agent", "adversarial", "fraud", "internal", "support"],
    requiredScope: "tools:kb.read",
    space: "public",
  },
  // --- Employee-only articles behind FGA spaces (the secondary /chat demo) -----------
  {
    id: "kb-oncall",
    title: "On-call rotation and escalation contacts",
    body: "The Platform on-call rotates weekly; the current primary and secondary are listed in the directory. Escalate a Sev-1 to the engineering manager on duty, then People Ops if it becomes an HR matter.",
    tags: ["on-call", "oncall", "escalation", "rotation", "contacts", "directory", "incident"],
    requiredScope: "tools:directory.read",
    space: "it",
  },
  {
    id: "kb-org-chart",
    title: "Team org chart and reporting lines",
    body: "Platform and IT roll up to the VP of Engineering; People and Finance roll up to the COO. Reporting lines and each manager's direct reports are maintained in the employee directory.",
    tags: ["org chart", "reporting", "manager", "directory", "structure", "team"],
    requiredScope: "tools:directory.read",
    space: "hr",
  },
  {
    id: "kb-comp-bands",
    title: "Compensation bands (confidential)",
    body: "Each level maps to a salary band with a defined midpoint; offers target 90–110% of midpoint. Bands are reviewed annually against market data. This document is restricted to payroll-authorized roles.",
    tags: ["compensation", "salary", "bands", "pay", "payroll", "levels", "confidential"],
    requiredScope: "tools:payroll.read",
    space: "finance",
  },
  {
    id: "kb-payroll-calendar",
    title: "Payroll calendar and cutoffs (confidential)",
    body: "Pay runs on the last business day of each month. Timesheet and adjustment cutoffs are the 25th. Off-cycle payments require Finance approval. Restricted to payroll-authorized roles.",
    tags: ["payroll", "pay", "calendar", "cutoff", "timesheet", "finance", "confidential"],
    requiredScope: "tools:payroll.read",
    space: "finance",
  },
];

export interface RankedArticle {
  article: Article;
  score: number;
}

/**
 * Function words the scorer ignores. Beyond the usual suspects this deliberately drops
 * pronouns and auxiliaries, because several of them collide with real tags: "what is it
 * used for" would otherwise score a tag hit on the IT department's "it" and look like an
 * internal question. A router that mistakes English grammar for a topic sends the wrong
 * turns to the wrong tools.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "of", "to", "for", "and", "or", "is", "are", "in", "on",
  "our", "my", "me", "what", "whats", "how", "do", "i", "we", "can", "get",
  "show", "tell", "about", "with", "s",
  "it", "its", "this", "that", "these", "those", "you", "your", "they", "them",
  "their", "be", "was", "were", "been", "am", "will", "would", "should",
  "could", "has", "have", "had", "does", "did", "by", "at", "as", "if", "so",
  "not", "from", "when", "where", "which", "who", "why", "there", "here",
  "than", "then", "but", "also", "just", "only", "more", "most", "some",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** True when an article is visible to a caller holding `callerScopes`. */
export function articleVisible(
  article: Article,
  callerScopes: string[]
): boolean {
  return (
    article.requiredScope === "public" ||
    callerScopes.includes(article.requiredScope)
  );
}

/**
 * Scope-filtered keyword retrieval. Filters the corpus down to what `callerScopes`
 * may see, THEN scores the survivors by keyword overlap against the query. An
 * article the caller can't see is never scored and never returned — its existence
 * doesn't leak. Returns the top `limit` matches with a non-zero score.
 */
export function searchKnowledgeBase(
  query: string,
  callerScopes: string[],
  limit = 3
): RankedArticle[] {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  const visible = ARTICLES.filter((a) => articleVisible(a, callerScopes));

  const ranked: RankedArticle[] = visible.map((article) => {
    const haystack = new Set(
      tokenize(`${article.title} ${article.body} ${article.tags.join(" ")}`)
    );
    let score = 0;
    for (const token of queryTokens) {
      if (haystack.has(token)) score += 1;
      // A tag exact-match is worth a little extra weight.
      if (article.tags.includes(token)) score += 1;
    }
    return { article, score };
  });

  return ranked
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** How many restricted articles the caller's scopes hide — for an honest note in the trace. */
export function hiddenArticleCount(callerScopes: string[]): number {
  return ARTICLES.filter((a) => !articleVisible(a, callerScopes)).length;
}

/**
 * Routing helper for the internal-first turn: does this prompt look like something
 * the internal corpus could actually answer? Scores the query against article TITLES
 * and TAGS (a tag hit counts double), which is signal about topics rather than prose.
 *
 * It is deliberately scope-blind and FGA-blind: it only decides whether the agent
 * SEARCHES, never what comes back. Retrieval still filters by the caller's scopes
 * (searchKnowledgeBase) and then by their FGA document relations (lib/mcp-server.ts),
 * so routing on the full corpus can't leak the existence of a restricted article —
 * an under-privileged caller just gets an empty result set and the external fallback.
 *
 * The scripted planner uses this instead of treating knowledge-base search as a
 * universal catch-all, so both planners route the same way: internal tools first, the
 * model's own knowledge only when nothing internal could serve the prompt.
 */
export function corpusMatches(query: string): boolean {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return false;

  return ARTICLES.some((article) => {
    const tagTokens = new Set(article.tags.flatMap((t) => tokenize(t)));
    const titleTokens = new Set(tokenize(article.title));
    let score = 0;
    for (const token of queryTokens) {
      if (tagTokens.has(token)) score += 2;
      if (titleTokens.has(token)) score += 1;
    }
    return score >= 2;
  });
}
