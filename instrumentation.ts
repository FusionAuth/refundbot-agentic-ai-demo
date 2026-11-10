/**
 * Server startup hook (Next.js instrumentation). Loads the FusionAuth FGA schema and the
 * catalog-derived demo relations/attributes once at boot, so the first refund doesn't
 * pay for it. Not awaited: if Permify isn't up yet (e.g. it starts after the app on
 * Railway), the app still boots, answers from the honest fallback, and goes live on its
 * own once Permify responds (see lib/fga.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureFgaBootstrap } = await import("@/lib/fga");
  void ensureFgaBootstrap()
    .then((mode) =>
      console.log(
        mode === "live"
          ? "[fga] Live FusionAuth FGA — schema and demo relations loaded."
          : "[fga] Demo fallback — no Permify reachable; static ownership/cap rules in use."
      )
    )
    .catch(() => {
      // ensureFgaBootstrap never throws by design; belt and braces for boot.
    });
}
