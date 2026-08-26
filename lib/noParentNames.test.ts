/**
 * A CHILD MAY NOT SAY THE NAME OF A PARENT.
 *
 * WHY THIS EXISTS ALONGSIDE THE ESCAPE CHECK
 * The build-time plugin in each parent asks "did this path leave the
 * workspace?" That misses the likeliest mistake by far: everything is checked
 * out side by side, so `../ReTreever/src/lib/foo` RESOLVES. It is inside the
 * workspace, it opens, the page renders — and it is meaningless the moment
 * this folder is published as its own repo, where no sibling named ReTreever
 * exists.
 *
 * So the rule here is about NAMES, not geometry. A child that writes the word
 * `ReTreever`, `rapper`, or `vercel` has hardcoded an assumption about who its
 * parent is. A child has TWO possible parents and must work under either, so
 * naming one is the defect regardless of whether the path currently resolves.
 *
 * WHY A TEST AND NOT A PLUGIN
 * A child ships no vite.config.ts — it is not an app, it is a folder a parent
 * builds. There is no build here to hook a plugin into. vitest needs no app,
 * so this runs in a bare clone of this folder alone: `npm test`. That is the
 * only enforcement an outside contributor can actually execute, which is
 * precisely the person this is for.
 *
 * WHAT IS ALLOWED
 * The alias. `$harness/...` names no parent — it is a seam each parent fills
 * in for itself, which is the whole mechanism. And this child's OWN name may
 * contain "ReTreever" (ReTreever_who_what), so a bare match on the word is
 * wrong; what is banned is naming a parent as a LOCATION.
 */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CHILD = fileURLToPath(new URL("..", import.meta.url));
const EXT = new Set([".svelte", ".ts", ".js", ".css", ".json"]);

function sources(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === "assets") continue;
		if (e.name.startsWith(".")) continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) sources(full, out);
		else if (EXT.has(extname(e.name))) out.push(full);
	}
	return out;
}

/**
 * A parent named as a PLACE: a path segment, an import, a URL host.
 *
 * Anchored on a path or protocol separator so it cannot fire on this child's
 * own folder name, or on prose in a comment explaining the rule.
 */
/**
 * A brand string is not a location.
 *
 * `Symbol.for("retreever.safeMarker.installed")` is a namespaced registry key —
 * it names nothing on disk and behaves identically under either parent, so it
 * is not the defect this test is about. Eight of them tripped the first
 * version, and a guard that cries wolf gets deleted, so they are exempt by
 * SHAPE (inside Symbol.for) rather than by listing them.
 */
const BRAND_STRING = /Symbol\.for\(/;

const PARENT_AS_LOCATION =
	/(?:\.\.?\/|["'`(]\/?|https?:\/\/[^"'`\s]*)(?:ReTreever|rapper|vercel)[/.]/gi;

describe("the child names no parent", () => {
	it("no path, import or URL names ReTreever, rapper or vercel", () => {
		const offenders: string[] = [];

		for (const file of sources(CHILD)) {
			// This file is ABOUT the rule; its prose names all three on purpose.
			if (file.endsWith("noParentNames.test.ts")) continue;
			const text = readFileSync(file, "utf8");
			// Joined over two lines so a Symbol.for(...) that WRAPS is still
			// recognised — the first version tested one line at a time and
			// missed `Symbol.for(\n  "retreever.safeCoveringTiles.installed")`.
			const lines = text.split("\n");
			for (const [i, line] of lines.entries()) {
				const stmt = `${lines[i - 1] ?? ""}\n${line}`;
				const t = line.trim();
				if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) {
					continue; // documentation, not a dependency
				}
				if (BRAND_STRING.test(stmt)) continue;
				for (const m of line.matchAll(PARENT_AS_LOCATION)) {
					offenders.push(`${relative(CHILD, file)}:${i + 1}  ${m[0]}`);
				}
			}
		}

		expect(
			offenders,
			`These name a PARENT as a location:\n\n` +
				offenders.map((o) => `  ${o}`).join("\n") +
				`\n\nA child has two possible parents and must run under either, so ` +
				`naming one is a defect even when the path resolves — and side by ` +
				`side on one machine, it DOES resolve. It stops resolving the ` +
				`moment this folder is published on its own, which is the point ` +
				`of the folder.\n\n` +
				`Reach a parent through the alias ($harness/...), or take what you ` +
				`need as a prop. Never by name.`,
		).toEqual([]);
	});

	it("the check bites — a parent-named path is detected", () => {
		// Without this, a broken regex silently passes everything above.
		const bad = 'import x from "../ReTreever/src/lib/foo";';
		const ok = 'import x from "$harness/getCache_OnlineMap/lib/foo";';
		expect([...bad.matchAll(PARENT_AS_LOCATION)].length).toBeGreaterThan(0);
		expect([...ok.matchAll(PARENT_AS_LOCATION)].length).toBe(0);
	});
});
