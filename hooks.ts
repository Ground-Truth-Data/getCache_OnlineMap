import type { Reroute } from "@sveltejs/kit";

/**
 * "/" RESOLVES TO THE DEFAULT VIEW — without becoming a second url for it.
 *
 * This child serves /map and /demo, so "/" has nothing of its own to be. Mounted
 * alone in a rapper, "/" is where every visitor LANDS, and with no answer here
 * it 404s on arrival — MEASURED 27 Aug 2026 on a fresh
 * `npm create @retreever/create-rapper` install: the bar rendered and the page
 * under it read "404 Not Found".
 *
 * `reroute` maps the url to a ROUTE without changing the address bar and
 * without a load running at all, so "/map" stays the only url that names
 * this view. The alternatives were both measured worse in the who_what child:
 * rendering the page at "/" too gives one view TWO urls, and a redirect from a
 * root `+page.ts` load 500s in this mount, because SvelteKit resolves the
 * child's routes through the PARENT's `kit.files.routes`.
 *
 * A UNIVERSAL hook, so hard loads and client-side navigations agree about what
 * "/" means. Reached only when a parent points `kit.files.hooks.universal` at
 * this file; a child cloned alone with its own config simply never runs it.
 */
export const reroute: Reroute = ({ url }) => {
	if (url.pathname === "/") return "/map";
};
