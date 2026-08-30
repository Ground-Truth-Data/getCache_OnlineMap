import type { Reroute } from "@sveltejs/kit";

/**
 * A CLOSED LOOP — every url this install can be given lands on a real page.
 *
 * THE DEFAULT is /map. "/" resolves here, the nav logo links here, and the
 * dev server prints it. Add /demo, this child's standalone preview, and that
 * is the WHOLE surface of a solo install.
 *
 * WHY ANYTHING ELSE COMES BACK RATHER THAN 404ING.
 * Someone who installed one child from npm has no other tier and no second
 * child. A url outside this set cannot be a page they meant to reach — it is a
 * typo, a stale bookmark, or a link copied from the two-tier workspace. Sending
 * them to a dead end is the worst of the three answers, so an unknown path
 * resolves to the default. There is no way to get stranded.
 *
 * `reroute` maps a url to a ROUTE without changing the address bar and without
 * a load running, so each view keeps exactly ONE url that names it. Alternatives
 * were measured worse in the who_what child: rendering a page at "/" too gives
 * one view TWO urls, and a redirect from a root `+page.ts` 500s in this mount,
 * because SvelteKit resolves the child's routes through the PARENT's
 * `kit.files.routes`.
 *
 * A UNIVERSAL hook, so hard loads and client-side navigations agree. Reached
 * only when a parent points `kit.files.hooks.universal` at this file; a child
 * cloned alone with its own config simply never runs it.
 *
 * KEEP IN STEP with this child's `defaultPath` in rapper/rig/childRegistry.ts —
 * that record is what the nav and the printed url read.
 */
const SERVED = ["/demo"];
const DEFAULT = "/map";

export const reroute: Reroute = ({ url }) => {
	// The DEFAULT counts as served too — it is the one url guaranteed to exist.
	// Listing it here rather than in SERVED keeps SERVED meaning "the OTHER
	// views", so the two constants stay readable side by side.
	const known = [DEFAULT, ...SERVED].some((p) => url.pathname === p);
	if (!known) return DEFAULT;
};
