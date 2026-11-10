/**
 * The refund knowledge base — a small, in-memory set of mock articles and a plain
 * keyword-overlap scorer (no vector database, no embeddings; see the README non-goals).
 *
 * Two audiences, kept apart by an explicit field rather than an OAuth scope:
 *
 *   - `customer` — the refund policy and FAQ. RefundBot's chat answers from these, and
 *     the landing page renders them.
 *   - `support` — internal escalation notes, shown only on the role-gated
 *     /support/approvals console. The customer chat searches the `customer` audience
 *     only, so these can never surface there.
 */

export type ArticleAudience = "customer" | "support";

export interface Article {
  id: string;
  title: string;
  body: string;
  tags: string[];
  audience: ArticleAudience;
}

export const ARTICLES: Article[] = [
  // --- Customer-visible refund policy + FAQ -----------------------------------------
  {
    id: "kb-refund-policy",
    title: "Refund policy",
    body: "You can request a refund on any order within 90 days of purchase, on any account you own or share. Refunds up to $100 are approved as soon as you confirm them; larger ones are also reviewed by a support specialist — unless your account is trusted for that amount.",
    tags: ["refund", "refunds", "policy", "return", "returns", "money back", "eligible"],
    audience: "customer",
  },
  {
    id: "kb-refund-timing",
    title: "When will I get my money?",
    body: "Once a refund is processed you'll get a confirmation number right away. Funds usually reach your original payment method within 3–5 business days.",
    tags: ["refund", "timing", "when", "money", "days", "payment", "how long"],
    audience: "customer",
  },
  {
    id: "kb-refund-confirmation",
    title: "Why do you ask me to confirm a refund?",
    body: "Refunds can't be undone, so we confirm with you directly through your account — not through the chat — before any money moves. If you didn't ask for it, just decline and nothing happens. Every refund needs this, whatever your account's status.",
    tags: ["refund", "confirm", "confirmation", "verify", "security", "mfa", "process"],
    audience: "customer",
  },
  {
    id: "kb-refund-review",
    title: "Why is my refund being reviewed?",
    body: "Refunds over $100 are reviewed by a specialist at the store that sold the order, or by their regional director for larger amounts — usually within one business day. You'll see the result in the chat as soon as it's decided.",
    tags: ["refund", "review", "specialist", "approval", "escalation", "window", "faq"],
    audience: "customer",
  },
  {
    id: "kb-refund-shared",
    title: "Can I get a refund on a family or shared account?",
    body: "Yes, if the account owner has added you as a delegate. You can request refunds on that account's orders the same way as on your own. You can't request a refund on an order from an account you don't own or share.",
    tags: ["refund", "family", "shared", "household", "delegate", "account", "someone else"],
    audience: "customer",
  },
  // --- Internal escalation notes (support console only) ------------------------------
  {
    id: "kb-escalation-thresholds",
    title: "Escalation notes: who can approve what",
    body: "You can approve escalated refunds for your own store up to its cap. Above that cap, or for another store's order, the region director approves instead — the console tells you which. Your approval is recorded against your user id and checked by the banking service. Customers can only reach refunds for orders on accounts they own or share; anything else was refused before it got here.",
    tags: ["escalation", "refund", "approval", "threshold", "cap", "store", "region", "internal", "support"],
    audience: "support",
  },
  {
    id: "kb-escalation-agents",
    title: "Escalation notes: customers using their own agents",
    body: "Some customers run AI agents that negotiate on their behalf and may claim prior approvals or invent amounts. Nothing they say changes the amount (it comes from order history), the order's ownership (that's checked against account relations), or skips an approval (the banking Grant doesn't exist until both are recorded). Judge the order, not the transcript.",
    tags: ["escalation", "agent", "adversarial", "fraud", "internal", "support"],
    audience: "support",
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

/**
 * Audience-filtered keyword retrieval: filters the corpus to one audience, THEN scores
 * the survivors by keyword overlap. Returns the top `limit` matches with a non-zero score.
 */
export function searchKnowledgeBase(
  query: string,
  audience: ArticleAudience,
  limit = 3
): RankedArticle[] {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  const visible = ARTICLES.filter((a) => a.audience === audience);

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
